/**
 * BM25 — the lexical half of #14's hybrid retrieval. A pure Okapi BM25 ranking
 * over the chunk corpus, fused with the vector ranking by RRF ({@link fuseByRrf}).
 *
 * Why a local BM25 and not only Atlas `$search`? ADR 0002 puts the live BM25
 * stage on an Atlas text index, but the index definition and search aggregation
 * are pure builders (atlas-index / vector-search-pipeline) that can't be scored
 * offline. This module is the deterministic ranking the unit suite and the
 * offline hit-rate triage exercise; the live path delegates to Atlas, which
 * implements the same Okapi formula. Keeping it pure (corpus + query in, ranked
 * ids out) means the fusion and provenance logic above it is testable without a
 * cluster.
 *
 * Standard Okapi BM25 with the usual defaults (`k1 = 1.5`, `b = 0.75`): term
 * frequency saturates (more hits help with diminishing returns), document
 * length is normalized against the corpus average, and IDF weights rarer query
 * terms higher. A term absent from the corpus contributes zero (no NaN).
 */

/** One document in the BM25 corpus: a stable id and its text. */
export interface Bm25Document {
  readonly id: string
  readonly text: string
}

/** A scored BM25 hit: the document id and its (non-negative) BM25 score. */
export interface Bm25Hit {
  readonly id: string
  readonly score: number
}

export interface Bm25RankOptions {
  readonly query: string
  readonly corpus: readonly Bm25Document[]
  readonly topK: number
  /** Term-frequency saturation parameter (Okapi default 1.5). */
  readonly k1?: number
  /** Length-normalization parameter (Okapi default 0.75). */
  readonly b?: number
}

const K1_DEFAULT = 1.5
const B_DEFAULT = 0.75

/** Lowercase a string and split it into word tokens (non-word chars split). */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0)
}

/** Inverse document frequency, BM25's smoothed variant (always > 0 for n>0). */
function idf(documentCount: number, docsWithTerm: number): number {
  return Math.log(1 + (documentCount - docsWithTerm + 0.5) / (docsWithTerm + 0.5))
}

/**
 * Rank the corpus against the query by BM25, returning the top-k hits with a
 * positive score in descending order (ties broken by id for determinism).
 * Documents with no query-term overlap are omitted.
 */
export function bm25Rank(options: Bm25RankOptions): readonly Bm25Hit[] {
  const { query, corpus, topK } = options
  const k1 = options.k1 ?? K1_DEFAULT
  const b = options.b ?? B_DEFAULT

  const queryTerms = new Set(tokenize(query))
  if (queryTerms.size === 0 || corpus.length === 0) return []

  const tokenized = corpus.map((doc) => ({ id: doc.id, tokens: tokenize(doc.text) }))
  const avgLength =
    tokenized.reduce((sum, doc) => sum + doc.tokens.length, 0) / tokenized.length || 0

  // Document frequency per query term (how many docs contain it at all).
  const docFreq = new Map<string, number>()
  for (const term of queryTerms) {
    let count = 0
    for (const doc of tokenized) {
      if (doc.tokens.includes(term)) count += 1
    }
    docFreq.set(term, count)
  }

  const hits: Bm25Hit[] = []
  for (const doc of tokenized) {
    const length = doc.tokens.length
    const termCounts = new Map<string, number>()
    for (const token of doc.tokens) {
      if (queryTerms.has(token)) termCounts.set(token, (termCounts.get(token) ?? 0) + 1)
    }
    if (termCounts.size === 0) continue

    let score = 0
    for (const [term, freq] of termCounts) {
      const df = docFreq.get(term) ?? 0
      if (df === 0) continue
      const numerator = freq * (k1 + 1)
      const denominator = freq + k1 * (1 - b + (b * length) / (avgLength || 1))
      score += idf(corpus.length, df) * (numerator / denominator)
    }
    if (score > 0) hits.push({ id: doc.id, score })
  }

  hits.sort((a, b2) => (b2.score === a.score ? (a.id < b2.id ? -1 : 1) : b2.score - a.score))
  return hits.slice(0, topK)
}
