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
import { type AgentModel, type AgentRetrieve } from './agent-types.js'
import { runAgentGraph } from './agent-graph.js'
import { type HybridCandidate } from './hybrid-retrieve.js'
import { type NaiveRagTracer } from './naive-rag.js'

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

/** Run the agent arm for one question, emitting a propagated-id trace. */
export async function runAgent(options: RunAgentOptions): Promise<RunAgentResult> {
  const { question, itemId, traceId, parentSpanId, topK, model, retrieve, onToken, tracer } =
    options
  const trace = tracer?.startTrace({
    name: 'owners-manual.agent',
    traceId,
    parentSpanId,
    input: { question, itemId },
    metadata: { arm: 'agent', itemId },
  })

  const startedAt = performance.now()
  const graphSpan = trace?.span('agent-graph', { question, topK })
  let state
  try {
    state = await runAgentGraph(question, { model, retrieve, topK, onToken }, itemId)
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
