/**
 * The SSE chat handler (#15): the black-box HTTP surface the UI streams from AND
 * the harness scores — one run, two consumers (issue #15 AC1). It sits BESIDE
 * the frozen naive-rag `/answer` handler (`service.ts`), reusing its request
 * shape, its trace-context resolution, and its tracer seam, and never reshapes
 * it.
 *
 * The handler is pure: it drives the agent arm (`runAgent`) and pushes Server-
 * Sent Events to an injected {@link ChatEventSink}, so the streaming protocol —
 * `token` events as synthesis streams, then one terminal `result` event with the
 * schema-validated envelope + retrieved path keys + run record — is unit-tested
 * offline against a scripted fake model. The thin `serve-cli` adapts a Node
 * `ServerResponse` to the sink and binds `ChatVertexAI` + Atlas hybrid retrieval.
 */

import { z } from 'zod'

import { type AnswerEnvelope } from './answer-envelope.js'
import {
  type AgentEnrichmentAccess,
  type AgentModel,
  type AgentRerank,
  type AgentRetrieve,
} from './agent-types.js'
import { type AgentQueryFlags } from './agent-query-flags.js'
import { runAgent, type AgentTracer } from './agent-run.js'
import { type RunRecord } from './run-record.js'

/** The chat request the client / harness POSTs. Mirrors `answerRequestSchema`. */
export const chatRequestSchema = z
  .object({
    question: z.string().min(1),
    itemId: z.string().min(1),
    /** W3C trace id (32 lowercase hex), propagated from the harness; optional. */
    traceId: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
  })
  .strict()

export type ChatRequest = z.infer<typeof chatRequestSchema> & {
  /** The harness's parent span id — from the `traceparent` HEADER, never the body. */
  readonly parentSpanId?: string
}

/** Validate an untyped request body into a {@link ChatRequest}. */
export function parseChatRequest(value: unknown): ChatRequest {
  return chatRequestSchema.parse(value)
}

/** The SSE event types the chat stream emits, in order: many `token`, one terminal. */
export type ChatEvent =
  | { readonly type: 'token'; readonly token: string }
  | {
      readonly type: 'result'
      readonly traceId?: string
      readonly envelope: AnswerEnvelope
      readonly retrievedCitablePathKeys: readonly string[]
      readonly runRecord: RunRecord
      readonly degraded: boolean
      readonly latencyMs: { readonly total: number }
    }
  | { readonly type: 'error'; readonly message: string }

/** The injected sink the handler pushes SSE events to (the live impl writes `res`). */
export type ChatEventSink = (event: ChatEvent) => void

/** The dependencies the chat handler needs — injected so the handler is pure. */
export interface ChatServiceDeps {
  readonly model: AgentModel
  readonly retrieve: AgentRetrieve
  /** The #16 rerank provider seam; only consulted when the `rerank` flag is on. */
  readonly rerank?: AgentRerank
  /** Read-only access to #13's sidecars; absent disables expansion/definitions. */
  readonly enrichment?: AgentEnrichmentAccess
  /** The #16 query-time ablation flags; defaults to all-off downstream. */
  readonly flags?: AgentQueryFlags
  readonly runRecord: RunRecord
  readonly topK: number
  readonly tracer?: AgentTracer
}

/**
 * Handle one chat request: stream synthesis tokens to the sink as the agent
 * runs, then emit one terminal `result` event carrying the schema-validated
 * envelope, the retrieved path keys (the harness's hit-rate input), the run
 * record, and the degraded flag. On failure it emits a single `error` event
 * rather than throwing across the stream boundary — the caller has already
 * opened the SSE response, so the error must travel as an event.
 */
export async function handleChatRequest(
  request: ChatRequest,
  deps: ChatServiceDeps,
  emit: ChatEventSink,
): Promise<void> {
  try {
    const result = await runAgent({
      question: request.question,
      itemId: request.itemId,
      traceId: request.traceId,
      parentSpanId: request.parentSpanId,
      topK: deps.topK,
      model: deps.model,
      retrieve: deps.retrieve,
      rerank: deps.rerank,
      enrichment: deps.enrichment,
      flags: deps.flags,
      onToken: (token) => emit({ type: 'token', token }),
      tracer: deps.tracer,
    })

    emit({
      type: 'result',
      traceId: request.traceId,
      envelope: result.envelope,
      retrievedCitablePathKeys: result.candidates.map((c) => c.citablePathKey),
      runRecord: deps.runRecord,
      degraded: result.degraded,
      latencyMs: result.latencyMs,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'error', message })
  }
}

/** Render one {@link ChatEvent} as an SSE wire frame: `event:` + `data:` + blank line. */
export function formatSseEvent(event: ChatEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
