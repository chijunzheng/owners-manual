/**
 * The naive-rag HTTP service request handler (issue #10). The Python harness
 * treats the TS service as a black box over HTTP (evals/README); this is the
 * pure handler behind that boundary, with all providers injected so it is
 * unit-tested offline. The thin `serve-cli` binds the live providers, the
 * Langfuse tracer, and an HTTP server around it.
 *
 * The request carries the question, the golden item id, and the PROPAGATED trace
 * id (AC2) — a 32-hex W3C trace id the service reuses verbatim so its Langfuse
 * spans share one trace with the harness. The response carries the
 * schema-validated answer envelope (AC3), the retrieved candidate path keys (the
 * harness computes retrieval hit rate from them), the run record (AC4:
 * manifest + pipeline-config snapshot), and per-stage latency.
 */

import { z } from 'zod'

import { type AnswerEnvelope } from './answer-envelope.js'
import { type EmbeddingProvider } from './embedding.js'
import { runNaiveRag, type NaiveRagTracer } from './naive-rag.js'
import { type VectorSearchExecutor } from './retrieve.js'
import { type RunRecord } from './run-record.js'
import { type LlmComplete } from './synthesize.js'

/** The request the harness POSTs per golden item. */
export const answerRequestSchema = z
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

export type AnswerRequest = z.infer<typeof answerRequestSchema> & {
  /** The harness's parent span id — from the `traceparent` HEADER, never the body. */
  readonly parentSpanId?: string
}

/** Validate an untyped request body into an {@link AnswerRequest}. */
export function parseAnswerRequest(value: unknown): AnswerRequest {
  return answerRequestSchema.parse(value)
}

/** W3C traceparent: `00-<32hex trace>-<16hex span>-<2hex flags>` (lowercase). */
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/

/**
 * Merge the body trace id with the `traceparent` header the harness sends
 * (service_client.py): a valid header contributes the parent span id so the
 * service spans nest under the harness span; a malformed header — or one whose
 * trace id contradicts the body — is ignored rather than trusted.
 */
export function resolveTraceContext(
  bodyTraceId: string | undefined,
  traceparentHeader: string | readonly string[] | undefined,
): { readonly traceId?: string; readonly parentSpanId?: string } {
  const header = Array.isArray(traceparentHeader) ? traceparentHeader[0] : traceparentHeader
  const match = typeof header === 'string' ? TRACEPARENT_PATTERN.exec(header) : null
  const headerTraceId = match?.[1]
  const headerSpanId = match?.[2]

  if (!headerTraceId || !headerSpanId) {
    return bodyTraceId ? { traceId: bodyTraceId } : {}
  }
  if (bodyTraceId && bodyTraceId !== headerTraceId) {
    return { traceId: bodyTraceId }
  }
  return { traceId: bodyTraceId ?? headerTraceId, parentSpanId: headerSpanId }
}

/** The dependencies a handler needs — injected so the handler is pure. */
export interface ServiceDeps {
  readonly provider: EmbeddingProvider
  readonly search: VectorSearchExecutor
  readonly complete: LlmComplete
  readonly runRecord: RunRecord
  readonly topK: number
  readonly tracer?: NaiveRagTracer
}

/** The response shape the harness consumes. */
export interface AnswerResponse {
  /** The propagated trace id, echoed for correlation. */
  readonly traceId?: string
  readonly envelope: AnswerEnvelope
  /** Every retrieved candidate's path key — input to retrieval hit rate. */
  readonly retrievedCitablePathKeys: readonly string[]
  readonly runRecord: RunRecord
  readonly latencyMs: {
    readonly retrieval: number
    readonly synthesis: number
    readonly total: number
  }
}

/** Handle one answer request: run the arm and shape the harness response. */
export async function handleAnswerRequest(
  request: AnswerRequest,
  deps: ServiceDeps,
): Promise<AnswerResponse> {
  const result = await runNaiveRag({
    question: request.question,
    itemId: request.itemId,
    traceId: request.traceId,
    parentSpanId: request.parentSpanId,
    topK: deps.topK,
    provider: deps.provider,
    search: deps.search,
    complete: deps.complete,
    tracer: deps.tracer,
  })

  return {
    traceId: request.traceId,
    envelope: result.envelope,
    retrievedCitablePathKeys: result.candidates.map((candidate) => candidate.citablePathKey),
    runRecord: deps.runRecord,
    latencyMs: result.latencyMs,
  }
}
