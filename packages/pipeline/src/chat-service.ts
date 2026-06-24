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
import { toRetrievedContexts, type RetrievedContext } from './service.js'
import { type RunRecord } from './run-record.js'
import { type OwnerProfile, type ProfileStore } from './owner-profile.js'
import {
  appendTurn,
  emptySessionMemory,
  type SessionMemory,
  type SessionMemoryStore,
  type SessionSummarizer,
} from './session-memory.js'

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
    /**
     * The owner whose profile (#17) to load and inject — cross-session facts.
     * Optional: a request with no owner id runs with no profile (the off-state).
     */
    ownerId: z.string().min(1).optional(),
    /**
     * The conversation whose bounded session summary (#17) to load, inject, and
     * update after the turn. Optional: no session id runs with no session memory.
     * DISTINCT from {@link ownerId} — one keys cross-session facts, the other a
     * per-conversation summary.
     */
    sessionId: z.string().min(1).optional(),
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
      /**
       * The retrieved chunk text per candidate (#76) — the live RAGAS context input
       * for the agent arm's OWN retrieval (bounded reformulation + graph expansion +
       * authority rerank), never a shared /retrieve/debug call. Aligned with
       * {@link retrievedCitablePathKeys}, candidate for candidate.
       */
      readonly retrievedContexts: readonly RetrievedContext[]
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
  /**
   * The #17 owner-profile store (mockable; live binding is Mongo). Absent →
   * profiles are never loaded, so a request's `ownerId` is a no-op (off-state).
   */
  readonly profileStore?: ProfileStore
  /**
   * The #17 session-memory store (mockable; live binding is Mongo). Absent →
   * session memory is never loaded or persisted, so `sessionId` is a no-op.
   */
  readonly sessionStore?: SessionMemoryStore
  /**
   * The #17 session summarizer — folds each turn into the bounded summary. Absent
   * → session memory is read but not updated. Injected so the bound is tested
   * offline against a deterministic fake; the live binding wraps the runtime model.
   */
  readonly summarize?: SessionSummarizer
  readonly runRecord: RunRecord
  readonly topK: number
  readonly tracer?: AgentTracer
}

/**
 * Load the owner profile for the request, or undefined when not applicable.
 *
 * SECURITY — v1 trust boundary (Codex P1 on PR #55): `ownerId` here and
 * `sessionId` in {@link loadSession} are taken from the request body and trusted
 * as-is. v1 is single-user, owner-side BYOD tooling, so there is no authenticated
 * principal to bind them to — auth/multi-tenancy is an explicit PRD non-goal
 * ("Out of Scope"). BEFORE any multi-tenant deploy (#24) these keys MUST be
 * derived from server-side auth/session state, not the body; otherwise a caller
 * could load another owner's profile or conversation summary by guessing an id
 * (IDOR). Tracked as a follow-up.
 */
async function loadProfile(
  request: ChatRequest,
  deps: ChatServiceDeps,
): Promise<OwnerProfile | undefined> {
  if (!request.ownerId || !deps.profileStore) return undefined
  return deps.profileStore.load(request.ownerId)
}

/**
 * Load the session memory for the request, or undefined when not applicable. A
 * fresh session (no stored summary) becomes an empty memory so the first turn
 * still records a baseline — the load is what makes a session's history available
 * to the next turn, while the profile is what makes facts available across sessions.
 */
async function loadSession(
  request: ChatRequest,
  deps: ChatServiceDeps,
): Promise<SessionMemory | undefined> {
  if (!request.sessionId || !deps.sessionStore) return undefined
  const stored = await deps.sessionStore.load(request.sessionId)
  return stored ?? emptySessionMemory(request.sessionId)
}

/**
 * Fold the just-finished turn into the bounded session summary and persist it
 * (#17 AC2). Skipped for a refusal — a refusal is not a substantive turn worth
 * summarizing, and folding it would pollute later turns with off-topic noise.
 * Requires a session id, a store, AND a summarizer; any missing piece is a no-op,
 * so the off-state never persists. The summary stays bounded because
 * {@link appendTurn} hard-caps it regardless of what the summarizer returns.
 */
async function persistSession(
  request: ChatRequest,
  deps: ChatServiceDeps,
  priorSession: SessionMemory | undefined,
  envelope: AnswerEnvelope,
): Promise<void> {
  if (!request.sessionId || !deps.sessionStore || !deps.summarize) return
  if (envelope.behaviorClass !== 'answer' && envelope.behaviorClass !== 'flag-void-clause') return
  const base = priorSession ?? emptySessionMemory(request.sessionId)
  const updated = await appendTurn(base, {
    question: request.question,
    answer: envelope.answer,
    summarize: deps.summarize,
  })
  await deps.sessionStore.save(updated)
}

/**
 * Handle one chat request: load the owner profile + session memory (#17), inject
 * BOTH (distinct mechanisms) into the agent run, stream synthesis tokens to the
 * sink, then emit one terminal `result` event carrying the schema-validated
 * envelope, the retrieved path keys (the harness's hit-rate input), the run
 * record, and the degraded flag. AFTER emitting that result it folds a substantive
 * turn into the bounded session summary and persists it as a best-effort write (a
 * persistence failure never masks the already-valid answer) — so the next turn
 * sees this one, while the durable profile is what later SESSIONS see (AC1). On failure it emits
 * a single `error` event rather than throwing across the stream boundary — the
 * caller has already opened the SSE response, so the error must travel as an event.
 */
export async function handleChatRequest(
  request: ChatRequest,
  deps: ChatServiceDeps,
  emit: ChatEventSink,
): Promise<void> {
  try {
    const [ownerProfile, sessionMemory] = await Promise.all([
      loadProfile(request, deps),
      loadSession(request, deps),
    ])

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
      ownerProfile,
      sessionMemory,
      onToken: (token) => emit({ type: 'token', token }),
      tracer: deps.tracer,
    })

    // Emit the terminal result BEFORE persisting session memory: the answer has
    // already streamed and is valid, so a persistence failure must not mask it
    // with an error event (Codex P2 on PR #55).
    emit({
      type: 'result',
      traceId: request.traceId,
      envelope: result.envelope,
      retrievedCitablePathKeys: result.candidates.map((c) => c.citablePathKey),
      // The SAME candidate set, projected to its chunk text for the live RAGAS
      // context columns (#76) — the agent arm's OWN retrieval, never a shared call.
      retrievedContexts: toRetrievedContexts(result.candidates),
      runRecord: deps.runRecord,
      degraded: result.degraded,
      latencyMs: result.latencyMs,
    })

    // Session persistence is best-effort (#17): folding and persisting the bounded
    // summary serves the NEXT turn, not this answer. A summarizer or Mongo `save`
    // failure must never turn an already-valid, already-emitted answer into an
    // error event — the same best-effort idiom as loadRootEnv in live/env.ts.
    try {
      await persistSession(request, deps, sessionMemory, result.envelope)
    } catch {
      // best-effort: the run is recorded on the tracer; the next turn simply
      // resumes from the last persisted summary.
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'error', message })
  }
}

/** Render one {@link ChatEvent} as an SSE wire frame: `event:` + `data:` + blank line. */
export function formatSseEvent(event: ChatEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
