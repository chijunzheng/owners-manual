/**
 * Reciprocal Rank Fusion (#14) — the rank-only fusion that merges the vector and
 * BM25 rankings into one ordered candidate set.
 *
 * RRF is score-free by construction: it uses each candidate's RANK in each
 * ranked list, never its score, so the two incommensurable scales (cosine
 * similarity vs Okapi BM25) never need normalizing into a shared range. The
 * fused score of an id is the sum over the lists it appears in of `1 / (k +
 * rank)` (rank 1-based); a higher score sorts earlier. The constant `k` (default
 * 60, the value from the original Cormack et al. RRF paper and most production
 * defaults) damps the contribution of low-ranked items.
 *
 * Each fused entry keeps its provenance — which stage ranked it, at what rank —
 * so hybrid retrieval can tag every candidate with stage-provenance (CONTEXT.md,
 * "Retrieval hit rate": component value shows up as mechanism, not just outcome).
 */

import { type RetrievalStage } from './retrieve.js'

/** The standard RRF damping constant (Cormack et al.). */
export const RRF_K_DEFAULT = 60

/** One ranked list from a single retrieval stage, best-first. */
export interface RankedList {
  readonly stage: RetrievalStage
  /** Candidate ids, in rank order (index 0 is rank 1). */
  readonly ids: readonly string[]
}

/** A fused candidate: its id, RRF score, and the rank each stage gave it. */
export interface FusedCandidate {
  readonly id: string
  readonly rrfScore: number
  /** The 1-based rank this id held in each contributing stage. */
  readonly ranks: Partial<Record<RetrievalStage, number>>
}

export interface FuseOptions {
  /** RRF damping constant; defaults to {@link RRF_K_DEFAULT}. */
  readonly k?: number
}

/**
 * Fuse ranked lists by Reciprocal Rank Fusion. Returns the union of all ids,
 * each with its summed RRF score and per-stage ranks, ordered by descending
 * score (ties broken by id for determinism). Empty lists contribute nothing.
 */
export function fuseByRrf(
  lists: readonly RankedList[],
  options: FuseOptions = {},
): FusedCandidate[] {
  const k = options.k ?? RRF_K_DEFAULT

  const scores = new Map<string, number>()
  const ranks = new Map<string, Partial<Record<RetrievalStage, number>>>()

  for (const list of lists) {
    list.ids.forEach((id, index) => {
      const rank = index + 1
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank))
      const entry = ranks.get(id) ?? {}
      entry[list.stage] = rank
      ranks.set(id, entry)
    })
  }

  const fused: FusedCandidate[] = [...scores.entries()].map(([id, rrfScore]) => ({
    id,
    rrfScore,
    ranks: ranks.get(id) ?? {},
  }))

  fused.sort((a, b) =>
    b.rrfScore === a.rrfScore ? (a.id < b.id ? -1 : 1) : b.rrfScore - a.rrfScore,
  )
  return fused
}
