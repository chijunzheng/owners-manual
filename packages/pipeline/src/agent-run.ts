/**
 * The agent arm orchestrator (#15): run the bounded Guard→Critic graph for one
 * question inside one Langfuse trace whose id is PROPAGATED from the harness,
 * exactly as the naive-rag arm does (mirror of `runNaiveRag`). One run produces
 * the structured answer envelope the harness scores AND — through `onToken` —
 * the token stream the SSE endpoint relays (one artifact, two consumers).
 *
 * The graph runs BESIDE the naive-rag arm: this module reuses the same injected
 * tracer seam ({@link AgentTracer}, structurally the naive-rag tracer) so the
 * agent's spans nest under the harness span the same way, and never reshapes the
 * frozen naive-rag path. The result carries the envelope, the merged candidate
 * set (the harness computes retrieval hit rate from it), the raw model text, the
 * degraded flag, and per-stage-ish latency.
 */

import { type AnswerEnvelope } from './answer-envelope.js'
import {
  type AgentEnrichmentAccess,
  type AgentModel,
  type AgentRerank,
  type AgentRetrieve,
} from './agent-types.js'
import { type AgentQueryFlags } from './agent-query-flags.js'
import { runAgentGraph } from './agent-graph.js'
import { type HybridCandidate } from './hybrid-retrieve.js'
import { type NaiveRagTracer, type TraceHandle } from './naive-rag.js'
import { OWNER_PROFILE_FACT_KEYS, type OwnerProfile } from './owner-profile.js'
import { type SessionMemory } from './session-memory.js'

/**
 * The tracer seam — identical in shape to {@link NaiveRagTracer}. Aliased so the
 * agent arm reads independently while the live Langfuse binding is shared.
 */
export type AgentTracer = NaiveRagTracer

export interface RunAgentOptions {
  readonly question: string
  readonly itemId: string
  /** The propagated trace id from the harness (W3C trace id, 32 hex chars). */
  readonly traceId?: string
  /** The harness's parent span id (16 hex chars, from `traceparent`). */
  readonly parentSpanId?: string
  readonly topK: number
  readonly model: AgentModel
  readonly retrieve: AgentRetrieve
  /** The #16 rerank provider seam; only consulted when the `rerank` flag is on. */
  readonly rerank?: AgentRerank
  /** Read-only access to #13's sidecars; absent disables expansion/definitions. */
  readonly enrichment?: AgentEnrichmentAccess
  /** The #16 query-time ablation flags; defaults to all-off downstream. */
  readonly flags?: AgentQueryFlags
  /**
   * The owner profile (#17): cross-session facts injected into synthesis. DISTINCT
   * from {@link sessionMemory}. Absent → no profile block (the off-state).
   */
  readonly ownerProfile?: OwnerProfile
  /**
   * The bounded session summary (#17): the rolling conversation summary injected
   * into synthesis. DISTINCT from {@link ownerProfile}. Absent → no session block.
   */
  readonly sessionMemory?: SessionMemory
  /** Streamed-token sink for the SSE endpoint; absent in scoring-only runs. */
  readonly onToken?: (token: string) => void
  readonly tracer?: AgentTracer
}

export interface RunAgentResult {
  readonly envelope: AnswerEnvelope
  readonly candidates: readonly HybridCandidate[]
  readonly rawModelOutput: string
  /** True when the Critic stayed ungrounded at the re-retrieval cap (honest degrade). */
  readonly degraded: boolean
  readonly latencyMs: {
    readonly total: number
  }
}

/**
 * Record the two #17 memory mechanisms as DISTINCT trace spans so both are
 * VISIBLE in Langfuse (AC3) and filterable apart — the owner profile and the
 * session summary are separate mechanisms (CONTEXT.md). The span output is
 * deliberately metadata-only: the profile's owner id + which fact KEYS are
 * present (never the values), and the session id + turn count + summary length
 * (never the summary text). That proves each mechanism flowed into the run
 * without leaking personal facts into the trace (security rule: traces never
 * carry sensitive data). A span opens only for a mechanism that is present, so
 * an off-state run adds no memory spans.
 */
function recordMemorySpans(
  trace: TraceHandle | undefined,
  ownerProfile: OwnerProfile | undefined,
  sessionMemory: SessionMemory | undefined,
): void {
  if (!trace) return
  if (ownerProfile) {
    const factKeys = OWNER_PROFILE_FACT_KEYS.filter((key) => ownerProfile.facts[key] !== undefined)
    const span = trace.span('owner-profile')
    span.setOutput({ ownerId: ownerProfile.ownerId, factKeys })
    span.end()
  }
  if (sessionMemory) {
    const span = trace.span('session-memory')
    span.setOutput({
      sessionId: sessionMemory.sessionId,
      turnCount: sessionMemory.turnCount,
      summaryChars: sessionMemory.summary.length,
    })
    span.end()
  }
}

/** Run the agent arm for one question, emitting a propagated-id trace. */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const {
    question,
    itemId,
    traceId,
    parentSpanId,
    topK,
    model,
    retrieve,
    rerank,
    enrichment,
    flags,
    ownerProfile,
    sessionMemory,
    onToken,
    tracer,
  } = options
  const trace = tracer?.startTrace({
    name: 'owners-manual.agent',
    traceId,
    parentSpanId,
    input: { question, itemId },
    metadata: { arm: 'agent', itemId },
  })

  const startedAt = performance.now()
  // Both #17 mechanisms become trace spans BEFORE the graph runs, so a trace
  // shows the memory that shaped synthesis even on an early refusal.
  recordMemorySpans(trace, ownerProfile, sessionMemory)
  const graphSpan = trace?.span('agent-graph', { question, topK })
  let state
  try {
    state = await runAgentGraph(
      question,
      { model, retrieve, rerank, enrichment, flags, topK, onToken },
      itemId,
      { ownerProfile, sessionMemory },
    )
    // Record the answer on the synthesis span (the agent-graph span) before
    // closing it — the prose is the whole point of a debuggable trace.
    if (state.envelope) {
      graphSpan?.setOutput({ answer: state.envelope.answer })
    }
  } finally {
    graphSpan?.end()
  }

  if (!state.envelope) {
    // The graph always terminates with an envelope (answer, refusal, or degraded);
    // a missing one is a wiring bug, surfaced loudly rather than returned as junk.
    throw new Error('agent graph terminated without an answer envelope')
  }

  trace?.setOutput({
    behaviorClass: state.envelope.behaviorClass,
    answer: state.envelope.answer,
    claims: state.envelope.claims,
    degraded: state.degraded,
  })

  return {
    envelope: state.envelope,
    candidates: state.candidates,
    rawModelOutput: state.rawModelOutput ?? '',
    degraded: state.degraded,
    latencyMs: { total: performance.now() - startedAt },
  }
}
