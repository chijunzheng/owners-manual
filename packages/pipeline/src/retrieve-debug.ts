/**
 * The retrieval-debug endpoint handler (#14 AC2).
 *
 * ADR 0003 makes this part of the contract, not a hack: "retrieval-only metrics
 * (precision@k before synthesis) need a debug endpoint on the TS service that
 * exposes ranked chunks". The Python harness (which treats the TS service as a
 * black box over HTTP) drives hybrid retrieval through this endpoint and reads
 * the candidates WITH their stage-provenance to compute the pre-synthesis
 * required-cite hit-rate and the hybrid-vs-vector-only comparison.
 *
 * The handler is pure — the embedding provider and the two search executors are
 * injected — so the request validation and the response shaping are unit-tested
 * offline; the thin serve-cli binds the live Atlas `$vectorSearch` + `$search`
 * executors around it. The response is deliberately flat and JSON-serializable:
 * every candidate carries the path key (graded hierarchically by the matcher),
 * the stages that surfaced it, the per-stage ranks, the fused RRF score, and the
 * authority level — the mechanism stats the hit-rate triage reports.
 */

import { z } from 'zod'

import { AUTHORITY_LEVELS, type AuthorityLevel } from './authority.js'
import { type EmbeddingProvider } from './embedding.js'
import { retrieveHybrid, type TextSearchExecutor } from './hybrid-retrieve.js'
import { type RetrievalStage, type VectorSearchExecutor } from './retrieve.js'

/**
 * Retrieval mode: `hybrid` (vector + BM25, RRF-fused) or `vector` (vector-only,
 * the frozen baseline's mechanism). Exposing both over the SAME hierarchy chunks
 * lets the harness isolate the BM25+RRF lift — the hybrid-vs-vector-only
 * comparison (#14 AC4) — by flipping one flag, not by also changing the chunker.
 */
export const RETRIEVE_DEBUG_MODES = ['hybrid', 'vector'] as const
export type RetrieveDebugMode = (typeof RETRIEVE_DEBUG_MODES)[number]

/** The debug request: a question, an optional top-k, mode, and authority filter. */
export const retrieveDebugRequestSchema = z
  .object({
    question: z.string().min(1),
    /** Per-request override of the configured top-k. */
    topK: z.number().int().positive().optional(),
    /** Retrieval mode; defaults to `hybrid`. */
    mode: z.enum(RETRIEVE_DEBUG_MODES).optional(),
    /** Keep only candidates at these authority levels (ADR 0002 metadata filter). */
    authorityLevels: z.array(z.enum(AUTHORITY_LEVELS)).nonempty().optional(),
  })
  .strict()

export type RetrieveDebugRequest = z.infer<typeof retrieveDebugRequestSchema>

/** Validate an untyped request body into a {@link RetrieveDebugRequest}. */
export function parseRetrieveDebugRequest(value: unknown): RetrieveDebugRequest {
  return retrieveDebugRequestSchema.parse(value)
}

/** The dependencies a debug handler needs — injected so the handler is pure. */
export interface RetrieveDebugDeps {
  readonly provider: EmbeddingProvider
  readonly vectorSearch: VectorSearchExecutor
  readonly textSearch: TextSearchExecutor
  /** The default top-k when the request omits one. */
  readonly topK: number
}

/** One candidate in the debug response, flat and JSON-serializable. */
export interface DebugCandidate {
  readonly documentId: string
  readonly citablePathKey: string
  readonly text: string
  /** Summary stage: `hybrid` when both stages found it, else the single stage. */
  readonly stage: RetrievalStage
  /** Every stage that surfaced this candidate. */
  readonly stages: readonly RetrievalStage[]
  /** The 1-based rank each contributing stage gave this candidate. */
  readonly stageRanks: Partial<Record<RetrievalStage, number>>
  /** The fused RRF score this candidate was ordered by. */
  readonly rrfScore: number
  readonly authorityLevel: AuthorityLevel
}

/** The debug response the harness consumes. */
export interface RetrieveDebugResponse {
  readonly question: string
  /** The mode this response was produced under (`hybrid` or `vector`). */
  readonly mode: RetrieveDebugMode
  readonly candidateCount: number
  /** The query embedding's dimension — surfaced for trace metadata. */
  readonly queryDimensions: number
  readonly candidates: readonly DebugCandidate[]
}

/** The empty BM25 stage used to run vector-only over the same vector hits. */
const NO_TEXT_SEARCH: TextSearchExecutor = async () => []

/**
 * Run hybrid retrieval for one debug request and shape the harness response.
 * Each candidate is projected to its provenance-bearing fields; the structured
 * {@link CitablePath} is dropped from the wire shape because the path key is the
 * grader's input and keeps the response flat.
 */
export async function handleRetrieveDebugRequest(
  request: RetrieveDebugRequest,
  deps: RetrieveDebugDeps,
): Promise<RetrieveDebugResponse> {
  const mode: RetrieveDebugMode = request.mode ?? 'hybrid'
  // Vector-only mode runs the SAME path with an empty BM25 stage, so the only
  // difference from hybrid is the fusion — isolating the BM25+RRF lift (AC4).
  const result = await retrieveHybrid({
    question: request.question,
    topK: request.topK ?? deps.topK,
    provider: deps.provider,
    vectorSearch: deps.vectorSearch,
    textSearch: mode === 'vector' ? NO_TEXT_SEARCH : deps.textSearch,
    authorityLevels: request.authorityLevels,
  })

  const candidates = result.candidates.map(
    (candidate): DebugCandidate => ({
      documentId: candidate.documentId,
      citablePathKey: candidate.citablePathKey,
      text: candidate.text,
      stage: candidate.stage,
      stages: candidate.stages,
      stageRanks: candidate.stageRanks,
      rrfScore: candidate.rrfScore,
      authorityLevel: candidate.authorityLevel,
    }),
  )

  return {
    question: request.question,
    mode,
    candidateCount: candidates.length,
    queryDimensions: result.queryDimensions,
    candidates,
  }
}
