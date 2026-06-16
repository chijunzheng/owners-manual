/**
 * Retrieval: embed the question, run Atlas vector search, return the top-k
 * candidates tagged with stage-provenance (CONTEXT.md, "Retrieval hit rate":
 * each candidate carries stage tags so component value shows up as mechanism).
 *
 * The naive-rag arm is vector-only, so every candidate is tagged `vector` — the
 * tag exists from day one so #14's BM25/rerank stages slot in without reshaping
 * the candidate type. The Atlas `$vectorSearch` aggregation is injected as a
 * {@link VectorSearchExecutor}, so this module's logic — embed, bound k, parse
 * each stored path-key back into a structured {@link CitablePath} for the
 * deterministic hit-rate/cite grader — is unit-tested offline; the live Mongo
 * aggregation lives in the index/search client.
 */

import { SEGMENT_KINDS, type CitablePath, type SegmentKind } from '@owners-manual/core'

import { type EmbeddingProvider } from './embedding.js'

/**
 * The provenance stage a candidate reached the candidate set through. `vector`
 * and `bm25` are the single-stage tags; `hybrid` marks a candidate surfaced by
 * BOTH the vector and BM25 stages and fused by RRF (#14); `graph-expansion`
 * marks a candidate pulled in by one-hop cross-reference expansion and
 * `rerank-survivor` a candidate the reranker kept/promoted (#16 — the two tags
 * CONTEXT.md "Retrieval hit rate" names, so each stage's value shows up as
 * MECHANISM: which required cites it rescued); `stuffed` marks a candidate that
 * reached the model with NO retrieval at all — the whole corpus stuffed into
 * context (#18 stuffing arms), so its provenance is "everything", not a stage.
 */
export type RetrievalStage =
  | 'vector'
  | 'bm25'
  | 'hybrid'
  | 'graph-expansion'
  | 'rerank-survivor'
  | 'stuffed'

/** A raw row returned by the vector search executor. */
export interface VectorSearchHit {
  readonly documentId: string
  readonly citablePathKey: string
  readonly text: string
  readonly score: number
}

/** The Atlas `$vectorSearch` call, injected so retrieval is testable offline. */
export type VectorSearchExecutor = (args: {
  readonly queryVector: readonly number[]
  readonly topK: number
}) => Promise<readonly VectorSearchHit[]>

/** One retrieved candidate, ready for synthesis and deterministic grading. */
export interface RetrievedCandidate {
  readonly documentId: string
  readonly citablePathKey: string
  /** The stored path-key parsed back to a structured address for the grader. */
  readonly path: CitablePath
  readonly text: string
  readonly score: number
  readonly stage: RetrievalStage
}

export interface RetrieveResult {
  readonly candidates: readonly RetrievedCandidate[]
  /** The query embedding's dimension — surfaced for trace metadata. */
  readonly queryDimensions: number
}

export interface RetrieveOptions {
  readonly question: string
  readonly topK: number
  readonly provider: EmbeddingProvider
  readonly search: VectorSearchExecutor
}

const SEGMENT_KIND_SET = new Set<string>(SEGMENT_KINDS)

/**
 * Inverse of `@owners-manual/parser`'s `pathKey`: split a stored
 * `documentId|kind:label|…` key back into a structured {@link CitablePath}.
 * Throws on a malformed key rather than guessing — a stored row that cannot be
 * graded is a build bug, not a silent zero.
 */
export function parsePathKey(key: string): CitablePath {
  const [documentId, ...rawSegments] = key.split('|')
  if (!documentId) throw new Error(`malformed path key (no documentId): "${key}"`)
  const segments = rawSegments.map((raw) => {
    const separator = raw.indexOf(':')
    if (separator < 0) throw new Error(`malformed path-key segment "${raw}" in "${key}"`)
    const kind = raw.slice(0, separator)
    const label = raw.slice(separator + 1)
    if (!SEGMENT_KIND_SET.has(kind) || !label) {
      throw new Error(`malformed path-key segment "${raw}" in "${key}"`)
    }
    return { kind: kind as SegmentKind, label }
  })
  return { documentId, segments }
}

/** Embed the question and return the top-k vector-stage candidates. */
export async function retrieveTopK(options: RetrieveOptions): Promise<RetrieveResult> {
  const { question, topK, provider, search } = options
  const queryVector = await provider.embedQuery(question)
  const hits = await search({ queryVector, topK })
  const candidates = hits.map((hit) => ({
    documentId: hit.documentId,
    citablePathKey: hit.citablePathKey,
    path: parsePathKey(hit.citablePathKey),
    text: hit.text,
    score: hit.score,
    stage: 'vector' as const,
  }))
  return { candidates, queryDimensions: queryVector.length }
}
