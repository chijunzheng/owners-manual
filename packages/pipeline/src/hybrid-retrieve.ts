/**
 * Hybrid retrieval (#14): embed the question, run Atlas vector search AND a BM25
 * text search, fuse the two rankings by RRF, and return candidates each tagged
 * with stage-provenance and authority level.
 *
 * ADR 0002 puts vector + BM25 with metadata pre-filtering on corpus AND
 * authority level in one query path. This module is that path, BESIDE the
 * naive-rag arm's vector-only `retrieveTopK` (which is frozen, #14): adding
 * hybrid retrieval never reshapes or replaces it. Both search executors are
 * injected (mirroring `retrieveTopK`), so the fusion, the provenance tagging,
 * the authority classification, and the metadata filter are unit-tested offline;
 * the live `$vectorSearch` and `$search` aggregations bind in the Mongo store.
 *
 * Stage-provenance is the headline output (CONTEXT.md, "Retrieval hit rate":
 * each candidate carries stage tags so component value shows up as MECHANISM,
 * not just outcome). Every candidate records which stages found it, the rank
 * each stage gave it, and the fused RRF score — so the hit-rate triage can say
 * "BM25 rescued N% of required cites vector similarity missed", deterministically.
 */

import { type CitablePath } from '@owners-manual/core'

import { authorityLevelOf, type AuthorityLevel } from './authority.js'
import { type EmbeddingProvider } from './embedding.js'
import {
  parsePathKey,
  type RetrievalStage,
  type VectorSearchExecutor,
  type VectorSearchHit,
} from './retrieve.js'
import { fuseByRrf, RRF_K_DEFAULT, type RankedList } from './rrf.js'

/**
 * The BM25 text-search call, injected so hybrid retrieval is testable offline.
 * Shaped exactly like {@link VectorSearchExecutor}: the live binding is Atlas
 * `$search` over the text index; the offline binding is {@link bm25Rank}.
 */
export type TextSearchExecutor = (args: {
  readonly query: string
  readonly topK: number
  /**
   * The document-id allow-list to PRE-filter the BM25 query by (#41 / ADR 0002).
   * When present and non-empty, the live binding moves the query into a `$search`
   * `compound.must` and adds the allow-list as a `compound.filter` over the
   * indexed `documentId` token — the lexical analog of `$vectorSearch.filter`.
   */
  readonly documentIds?: readonly string[]
}) => Promise<readonly VectorSearchHit[]>

/** One hybrid candidate: a retrieved candidate plus full fusion provenance. */
export interface HybridCandidate {
  readonly documentId: string
  readonly citablePathKey: string
  /** The stored path-key parsed back to a structured address for the grader. */
  readonly path: CitablePath
  readonly text: string
  /** The fused RRF score — the value this candidate was ordered by. */
  readonly score: number
  /** Summary stage: `hybrid` when both stages found it, else the single stage. */
  readonly stage: RetrievalStage
  /** Every stage that surfaced this candidate (sorted, deterministic). */
  readonly stages: readonly RetrievalStage[]
  /** The 1-based rank each contributing stage gave this candidate. */
  readonly stageRanks: Partial<Record<RetrievalStage, number>>
  /** The fused RRF score, named explicitly for the debug endpoint. */
  readonly rrfScore: number
  /** The candidate's authority level (ADR 0002 metadata filter / rerank). */
  readonly authorityLevel: AuthorityLevel
}

export interface RetrieveHybridResult {
  readonly candidates: readonly HybridCandidate[]
  /** The query embedding's dimension — surfaced for trace metadata. */
  readonly queryDimensions: number
}

export interface RetrieveHybridOptions {
  readonly question: string
  readonly topK: number
  readonly provider: EmbeddingProvider
  readonly vectorSearch: VectorSearchExecutor
  readonly textSearch: TextSearchExecutor
  /** When set, keep only candidates at these authority levels (ADR 0002 filter). */
  readonly authorityLevels?: readonly AuthorityLevel[]
  /**
   * The document-id allow-list the authority levels resolve to (#41) — pushed into
   * the stages as a true PRE-filter (`$vectorSearch.filter` / `$search`
   * `compound.filter`) so a higher-authority chunk is never crowded out of a
   * stage's over-fetch window by disallowed documents. Resolved at the call site
   * from the corpus's known id set (serve-cli), because the inverse of the by-id
   * authority classifier needs that set. When omitted, the stages are unfiltered
   * and only the post-fusion {@link authorityLevels} guard applies (the interim
   * behaviour, retained as belt-and-suspenders).
   */
  readonly documentFilter?: readonly string[]
  /** RRF damping constant; defaults to {@link RRF_K_DEFAULT}. */
  readonly rrfK?: number
  /**
   * Per-stage over-fetch before fusion. Each stage is asked for `topK * factor`
   * candidates so a cite ranked outside the final top-k by one stage can still
   * be rescued by the other through fusion. Default 3.
   */
  readonly perStageFactor?: number
}

const PER_STAGE_FACTOR_DEFAULT = 3

/** The summary stage tag for a candidate: `hybrid` if multi-stage, else the one stage. */
function summaryStage(stages: readonly RetrievalStage[]): RetrievalStage {
  return stages.length > 1 ? 'hybrid' : stages[0]!
}

/**
 * Run hybrid retrieval: vector + BM25, fused by RRF, tagged with provenance and
 * authority, optionally filtered by authority level, truncated to top-k.
 */
export async function retrieveHybrid(
  options: RetrieveHybridOptions,
): Promise<RetrieveHybridResult> {
  const { question, topK, provider, vectorSearch, textSearch } = options
  const perStageFactor = options.perStageFactor ?? PER_STAGE_FACTOR_DEFAULT
  const perStageK = Math.max(topK * perStageFactor, topK)

  // The TRUE pre-filter (#41 / ADR 0002): an empty allow-list is a no-op, never a
  // filter that drops everything, so it collapses to undefined here and the stages
  // run unfiltered. A non-empty list rides into BOTH stages so each over-fetch
  // window already holds only allowed documents.
  const documentFilter =
    options.documentFilter && options.documentFilter.length > 0 ? options.documentFilter : undefined

  const queryVector = await provider.embedQuery(question)
  const [vectorHits, textHits] = await Promise.all([
    vectorSearch({ queryVector, topK: perStageK, documentIds: documentFilter }),
    textSearch({ query: question, topK: perStageK, documentIds: documentFilter }),
  ])

  // Index hits by path key so the fused id maps back to the stored row text.
  const byKey = new Map<string, VectorSearchHit>()
  for (const hit of [...vectorHits, ...textHits]) {
    if (!byKey.has(hit.citablePathKey)) byKey.set(hit.citablePathKey, hit)
  }

  const lists: RankedList[] = [
    { stage: 'vector', ids: vectorHits.map((h) => h.citablePathKey) },
    { stage: 'bm25', ids: textHits.map((h) => h.citablePathKey) },
  ]
  const fused = fuseByRrf(lists, { k: options.rrfK ?? RRF_K_DEFAULT })

  // Authority filter — BELT-AND-SUSPENDERS (#41 AC4). The true metadata PRE-filter
  // now rides inside the stages via `documentFilter` (`$vectorSearch.filter` /
  // `$search` compound.filter; the indexes declare `documentId` filterable, see
  // atlas-index.ts), so the `perStageK` over-fetch window already holds only allowed
  // documents and a higher-authority chunk is no longer crowded out before fusion.
  // This post-fusion allow-list is retained as a second line of defence: it GUARANTEES
  // no candidate at a disallowed authority level is ever returned even if the
  // pre-filter is bypassed (a stale `documentFilter`, an executor that ignores it,
  // or `authorityLevels` supplied without a resolved `documentFilter`).
  const allow = options.authorityLevels ? new Set(options.authorityLevels) : undefined

  const candidates: HybridCandidate[] = []
  for (const entry of fused) {
    const hit = byKey.get(entry.id)
    if (!hit) continue
    const authorityLevel = authorityLevelOf(hit.documentId)
    if (allow && !allow.has(authorityLevel)) continue
    const stages = (Object.keys(entry.ranks) as RetrievalStage[]).sort()
    candidates.push({
      documentId: hit.documentId,
      citablePathKey: hit.citablePathKey,
      path: parsePathKey(hit.citablePathKey),
      text: hit.text,
      score: entry.rrfScore,
      stage: summaryStage(stages),
      stages,
      stageRanks: entry.ranks,
      rrfScore: entry.rrfScore,
      authorityLevel,
    })
  }

  return { candidates: candidates.slice(0, topK), queryDimensions: queryVector.length }
}
