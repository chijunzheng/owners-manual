/**
 * The stuffing-arm orchestrator (#18): the no-retrieval arms `stuff` (entire
 * corpus, fixed canonical order) and `stuff-oracle` (corpus-tag-routed subset).
 * Mirrors `runNaiveRag` — same trace seam, same propagated-id discipline, same
 * envelope output — minus the retrieval stage: the candidate set IS the stuffed
 * corpus, so there is no `retrieve` span and no embedding provider.
 *
 * Both arms run the SAME product model as naive-rag and the agent (ADR 0005), so
 * the four-arm gap measures architecture, never model choice. The arm records
 * token usage (with the Vertex context-cache hit) and a cost-per-question
 * computed from injected, pinned rates — honest cost, not a hidden full-prompt
 * bill. The order seed it stuffed in is reported so the order-permutation probe
 * (seed ≠ 0) can confirm the arm is not a prefix-order artifact. The tracer and
 * the model are injected; the live caching binding lives in the service/CLI.
 */

import { type CorpusChunk } from './chunk-corpus.js'
import { type AnswerEnvelope } from './answer-envelope.js'
import { type NaiveRagTracer } from './naive-rag.js'
import { type RetrievedCandidate } from './retrieve.js'
import {
  buildStuffedCandidates,
  permuteCanonicalOrder,
  stuffedSourceCount,
  synthesizeStuffed,
  type StuffLlmComplete,
  type StuffUsage,
} from './stuff-synthesis.js'

/** The two stuffing arms. `stuff` is the honest no-RAG arm; `stuff-oracle` is routed. */
export type StuffArm = 'stuff' | 'stuff-oracle'

/** The stuffing arms reuse the naive-rag tracer seam (same trace shape). */
export type StuffTracer = NaiveRagTracer

/**
 * Per-million-token USD rates for the honest cost-per-question, pinned in config
 * (never hardcoded in the arm). `cachedInputPerMTok` is the discounted rate the
 * Vertex context cache bills the corpus prefix at; the uncached remainder bills
 * at `inputPerMTok`. Defaults to all-zero so the unit suite asserts mechanics
 * without depending on a price.
 */
export interface StuffCostRates {
  readonly inputPerMTok: number
  readonly cachedInputPerMTok: number
  readonly outputPerMTok: number
}

const ZERO_RATES: StuffCostRates = { inputPerMTok: 0, cachedInputPerMTok: 0, outputPerMTok: 0 }

/**
 * Honest cost for one stuffed call: the uncached prompt slice at the input rate,
 * the cached slice at the (cheaper) cache rate, and the completion at the output
 * rate. Cached tokens are clamped to the prompt total so a provider over-report
 * cannot produce a negative uncached count.
 */
export function stuffCostUsd(usage: StuffUsage, rates: StuffCostRates): number {
  const cached = Math.min(usage.cachedPromptTokens, usage.promptTokens)
  const uncached = usage.promptTokens - cached
  const perToken = (perMTok: number): number => perMTok / 1_000_000
  return (
    uncached * perToken(rates.inputPerMTok) +
    cached * perToken(rates.cachedInputPerMTok) +
    usage.completionTokens * perToken(rates.outputPerMTok)
  )
}

export interface RunStuffOptions {
  readonly question: string
  readonly itemId: string
  readonly arm: StuffArm
  /** The stuffed corpus chunks — entire (stuff) or routed (stuff-oracle), in canonical order. */
  readonly chunks: readonly CorpusChunk[]
  readonly complete: StuffLlmComplete
  /** The propagated trace id from the harness (W3C trace id, 32 hex chars). */
  readonly traceId?: string
  /** The harness's parent span id (16 hex chars, from `traceparent`). */
  readonly parentSpanId?: string
  /** Order-permutation probe seed; 0 (default) is the canonical baseline. */
  readonly orderSeed?: number
  /** Pinned per-token rates for the honest cost; defaults to zero. */
  readonly costRates?: StuffCostRates
  readonly tracer?: StuffTracer
}

export interface RunStuffResult {
  readonly envelope: AnswerEnvelope
  readonly candidates: readonly RetrievedCandidate[]
  readonly rawModelOutput: string
  /** How many sources were stuffed (the no-RAG denominator). */
  readonly stuffedSourceCount: number
  readonly usage: StuffUsage
  readonly costUsd: number
  /** The order the corpus was stuffed in (0 = canonical baseline). */
  readonly orderSeed: number
  readonly latencyMs: {
    readonly synthesis: number
    readonly total: number
  }
}

/** Run a stuffing arm for one question, emitting a propagated-id trace. */
export async function runStuff(options: RunStuffOptions): Promise<RunStuffResult> {
  const {
    question,
    itemId,
    arm,
    chunks,
    complete,
    traceId,
    parentSpanId,
    orderSeed = 0,
    costRates = ZERO_RATES,
    tracer,
  } = options

  if (chunks.length === 0) {
    throw new Error(
      `stuffing arm "${arm}" was given no chunks to stuff (empty corpus is a build bug)`,
    )
  }

  const trace = tracer?.startTrace({
    name: `owners-manual.${arm}`,
    traceId,
    parentSpanId,
    input: { question, itemId },
    metadata: { arm, itemId, orderSeed },
  })

  const startedAt = performance.now()

  // Fix the stuffed order (canonical baseline at seed 0, a stable permutation
  // otherwise) BEFORE building candidates, so the prompt order matches the seed.
  const orderedChunks = permuteCanonicalOrder(chunks, orderSeed)
  const candidates = buildStuffedCandidates(orderedChunks)

  const synthesizeSpan = trace?.span('synthesize', { stuffedSourceCount: candidates.length })
  const synthesisStart = performance.now()
  let synthesized
  try {
    synthesized = await synthesizeStuffed({ question, candidates, complete })
    synthesizeSpan?.setOutput({ answer: synthesized.envelope.answer })
  } finally {
    synthesizeSpan?.end()
  }
  const synthesisMs = performance.now() - synthesisStart

  trace?.setOutput({
    behaviorClass: synthesized.envelope.behaviorClass,
    answer: synthesized.envelope.answer,
    claims: synthesized.envelope.claims,
    stuffedSourceCount: candidates.length,
  })

  return {
    envelope: synthesized.envelope,
    candidates,
    rawModelOutput: synthesized.rawModelOutput,
    stuffedSourceCount: stuffedSourceCount(orderedChunks),
    usage: synthesized.usage,
    costUsd: stuffCostUsd(synthesized.usage, costRates),
    orderSeed,
    latencyMs: {
      synthesis: synthesisMs,
      total: performance.now() - startedAt,
    },
  }
}
