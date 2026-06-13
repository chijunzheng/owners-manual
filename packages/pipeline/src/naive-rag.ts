/**
 * The naive-rag arm orchestrator: retrieve → synthesize → validate, wrapped in
 * one Langfuse trace whose id is PROPAGATED from the Python harness (issue #10
 * AC2: "trace-id propagation from harness to service spans").
 *
 * The arm is deliberately linear — no Planner, no Critic gate (CONTEXT.md,
 * "Naive-RAG baseline"). Its job in this slice is to be the first end-to-end
 * number and the reference point every richer arm is paired against. The tracer
 * is an injected abstraction ({@link NaiveRagTracer}) so this module stays
 * provider-free and unit-testable; the live binding (Langfuse TS SDK, trace
 * `id` set to the propagated value) lives in the service. The result carries
 * the answer envelope, the full candidate set (the harness computes retrieval
 * hit rate from it), the raw model text, and per-stage latency.
 */

import { retrieveTopK, type RetrievedCandidate, type VectorSearchExecutor } from './retrieve.js'
import { synthesize, type LlmComplete } from './synthesize.js'
import { type AnswerEnvelope } from './answer-envelope.js'
import { type EmbeddingProvider } from './embedding.js'

/** A span opened under a trace: name it, get an `end()`. */
export interface TraceSpan {
  end(): void
}

/** A trace opened for one item, possibly under a propagated trace id. */
export interface TraceHandle {
  /** Open a named child span. */
  span(name: string, input?: unknown): TraceSpan
  /** Attach the final output to the trace. */
  setOutput(output: unknown): void
}

/** The tracer seam — the live impl wraps the Langfuse TS SDK. */
export interface NaiveRagTracer {
  startTrace(options: {
    readonly name: string
    /** The propagated trace id; when set, spans nest under the harness trace. */
    readonly traceId?: string
    /** The harness's span id (W3C traceparent); service spans nest under it. */
    readonly parentSpanId?: string
    readonly input?: unknown
    readonly metadata?: Record<string, unknown>
  }): TraceHandle
}

export interface RunNaiveRagOptions {
  readonly question: string
  readonly itemId: string
  /** The propagated trace id from the harness (W3C trace id, 32 hex chars). */
  readonly traceId?: string
  /** The harness's parent span id (16 hex chars, from `traceparent`). */
  readonly parentSpanId?: string
  readonly topK: number
  readonly provider: EmbeddingProvider
  readonly search: VectorSearchExecutor
  readonly complete: LlmComplete
  readonly tracer?: NaiveRagTracer
}

export interface RunNaiveRagResult {
  readonly envelope: AnswerEnvelope
  readonly candidates: readonly RetrievedCandidate[]
  readonly rawModelOutput: string
  readonly latencyMs: {
    readonly retrieval: number
    readonly synthesis: number
    readonly total: number
  }
}

/** Run the naive-rag arm for one question, emitting a propagated-id trace. */
export async function runNaiveRag(options: RunNaiveRagOptions): Promise<RunNaiveRagResult> {
  const { question, itemId, traceId, parentSpanId, topK, provider, search, complete, tracer } =
    options
  const trace = tracer?.startTrace({
    name: 'owners-manual.naive-rag',
    traceId,
    parentSpanId,
    input: { question, itemId },
    metadata: { arm: 'naive-rag', itemId },
  })

  const startedAt = performance.now()

  const retrieveSpan = trace?.span('retrieve', { question, topK })
  const retrievalStart = performance.now()
  const retrieval = await retrieveTopK({ question, topK, provider, search })
  const retrievalMs = performance.now() - retrievalStart
  retrieveSpan?.end()

  const synthesizeSpan = trace?.span('synthesize', { candidateCount: retrieval.candidates.length })
  const synthesisStart = performance.now()
  let synthesized
  try {
    synthesized = await synthesize({ question, candidates: retrieval.candidates, complete })
  } finally {
    synthesizeSpan?.end()
  }
  const synthesisMs = performance.now() - synthesisStart

  trace?.setOutput({ behaviorClass: synthesized.envelope.behaviorClass })

  return {
    envelope: synthesized.envelope,
    candidates: retrieval.candidates,
    rawModelOutput: synthesized.rawModelOutput,
    latencyMs: {
      retrieval: retrievalMs,
      synthesis: synthesisMs,
      total: performance.now() - startedAt,
    },
  }
}
