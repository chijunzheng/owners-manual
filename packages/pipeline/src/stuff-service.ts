/**
 * The stuffing-arm HTTP handlers (#18): the pure handlers behind the additive
 * `POST /stuff` and `POST /stuff-oracle` routes. They sit BESIDE the frozen
 * naive-rag `/answer` and agent `/chat` handlers (`service.ts`, `chat-service.ts`)
 * — reusing their request shape, trace-context resolution, and run-record echo —
 * and never reshape them.
 *
 * `stuff` stuffs the ENTIRE corpus (fixed canonical order); `stuff-oracle` stuffs
 * only the corpora the harness's oracle routed to (corpus selection is itself
 * retrieval, CONTEXT.md). Both emit the SAME `AnswerEnvelope` under the SAME
 * product model as the other arms (ADR 0005) plus stuffing-specific fields: the
 * stuffed source count, token usage with the context-cache hit, the honest cost,
 * and the order seed (for the order-permutation probe). The handler is pure — the
 * corpus chunks, the model, the run record, and the pinned cost rates are
 * injected — so the live `serve-cli` binds Vertex context caching around it.
 */

import { z } from 'zod'

import { type AnswerEnvelope } from './answer-envelope.js'
import { CORPORA, type CorpusTag } from './corpus-tag.js'
import { type CorpusChunk } from './chunk-corpus.js'
import { runStuff, type StuffArm, type StuffCostRates, type StuffTracer } from './stuff.js'
import { type RunRecord } from './run-record.js'
import { type StuffLlmComplete, type StuffUsage } from './stuff-synthesis.js'

/** The `/stuff` request: the honest no-RAG arm — no corpus routing. */
export const stuffRequestSchema = z
  .object({
    question: z.string().min(1),
    itemId: z.string().min(1),
    /** W3C trace id (32 lowercase hex), propagated from the harness; optional. */
    traceId: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .optional(),
    /** Order-permutation probe seed; omitted = canonical baseline (0). */
    orderSeed: z.number().int().nonnegative().optional(),
  })
  .strict()

/** The `/stuff-oracle` request: adds the oracle's routed corpora (≥1 required). */
export const stuffOracleRequestSchema = stuffRequestSchema
  .extend({
    /** The corpora the oracle routed to — corpus selection IS retrieval here. */
    corpora: z.array(z.enum(CORPORA)).min(1),
  })
  .strict()

export type StuffRequestBody = z.infer<typeof stuffRequestSchema>
export type StuffOracleRequestBody = z.infer<typeof stuffOracleRequestSchema>

/** Validate an untyped body into a `/stuff` request. */
export function parseStuffRequest(value: unknown): StuffRequestBody {
  return stuffRequestSchema.parse(value)
}

/** Validate an untyped body into a `/stuff-oracle` request. */
export function parseStuffOracleRequest(value: unknown): StuffOracleRequestBody {
  return stuffOracleRequestSchema.parse(value)
}

/** The internal request the handler runs — discriminated by arm. */
export interface StuffRequest {
  readonly question: string
  readonly itemId: string
  readonly arm?: StuffArm
  readonly corpora?: readonly CorpusTag[]
  readonly orderSeed?: number
  readonly traceId?: string
  /** The harness's parent span id — from the `traceparent` HEADER, never the body. */
  readonly parentSpanId?: string
}

/** The dependencies the stuff handlers need — injected so the handler is pure. */
export interface StuffServiceDeps {
  readonly complete: StuffLlmComplete
  /**
   * Optionally resolve the completion per arm AND order seed (#44): canonical-order
   * `stuff` (seed 0) rides the context cache (its prompt IS the cached prefix + the
   * question, sent suffix-only), while `stuff-oracle` runs UNCACHED — it routes a
   * SUBSET of the corpus, so its prompt is not the cached prefix + a suffix. The
   * order-permutation probe (`orderSeed > 0`) also runs UNCACHED: its prompt is built
   * over PERMUTED chunks, so it is not the cached canonical prefix — hence the seed is
   * forwarded so the binding can route the probe around the cache (Codex P2 on #44).
   * When omitted, {@link StuffServiceDeps.complete} serves both arms (the pure default
   * the unit suite uses).
   */
  readonly completeForArm?: (arm: StuffArm, orderSeed: number) => StuffLlmComplete
  readonly runRecord: RunRecord
  /**
   * Resolve the chunks to stuff for an arm: the entire corpus for `stuff`, the
   * routed subset for `stuff-oracle` (filtered by the oracle-supplied corpora).
   */
  readonly chunksForArm: (arm: StuffArm, corpora?: readonly CorpusTag[]) => readonly CorpusChunk[]
  /** Pinned per-token cost rates; omitted = zero (the unit suite asserts mechanics). */
  readonly costRates?: StuffCostRates
  readonly tracer?: StuffTracer
}

/** The response shape the harness consumes — `AnswerResponse` plus stuffing fields. */
export interface StuffResponse {
  readonly traceId?: string
  readonly arm: StuffArm
  readonly envelope: AnswerEnvelope
  readonly retrievedCitablePathKeys: readonly string[]
  readonly stuffedSourceCount: number
  readonly usage: StuffUsage
  readonly costUsd: number
  readonly orderSeed: number
  readonly runRecord: RunRecord
  readonly latencyMs: {
    readonly synthesis: number
    readonly total: number
  }
}

/** Handle one stuffing request: route the corpus, run the arm, shape the response. */
export async function handleStuffRequest(
  request: StuffRequest,
  deps: StuffServiceDeps,
): Promise<StuffResponse> {
  const arm: StuffArm = request.arm ?? 'stuff'
  const orderSeed = request.orderSeed ?? 0
  const chunks = deps.chunksForArm(arm, request.corpora)
  // Pick the completion by arm AND order seed: the cache serves only canonical-order
  // `stuff` (seed 0); `stuff-oracle` and the order-permutation probe (seed > 0) run
  // uncached, since neither prompt is the cached canonical prefix (#44). Absent the
  // resolver, the single injected completion serves both arms (the pure default).
  const complete = deps.completeForArm?.(arm, orderSeed) ?? deps.complete

  const result = await runStuff({
    question: request.question,
    itemId: request.itemId,
    arm,
    chunks,
    complete,
    traceId: request.traceId,
    parentSpanId: request.parentSpanId,
    orderSeed,
    costRates: deps.costRates,
    tracer: deps.tracer,
  })

  return {
    traceId: request.traceId,
    arm,
    envelope: result.envelope,
    retrievedCitablePathKeys: result.candidates.map((candidate) => candidate.citablePathKey),
    stuffedSourceCount: result.stuffedSourceCount,
    usage: result.usage,
    costUsd: result.costUsd,
    orderSeed: result.orderSeed,
    runRecord: deps.runRecord,
    latencyMs: result.latencyMs,
  }
}
