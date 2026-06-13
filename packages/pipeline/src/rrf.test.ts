import { describe, expect, it } from 'vitest'

import { RRF_K_DEFAULT, fuseByRrf, type RankedList } from './rrf.js'

/**
 * Reciprocal Rank Fusion (#14): the rank-only fusion that combines the vector
 * and BM25 rankings into one ordered candidate set. Score-free by design — it
 * uses each candidate's RANK in each list, so the two incommensurable score
 * scales (cosine similarity vs Okapi BM25) never need normalizing.
 *
 * Pinned contract:
 *   - RRF score of an id = sum over lists of 1 / (k + rank), rank 1-based;
 *   - an id present in BOTH lists outranks one strong in a single list (the
 *     whole point of fusion — agreement is signal);
 *   - the fused order is by descending RRF score, ties broken deterministically;
 *   - lists need not share ids; a missing id simply contributes nothing from
 *     that list;
 *   - empty input fuses to empty.
 */

const vector: RankedList = { stage: 'vector', ids: ['a', 'b', 'c'] }
const bm25: RankedList = { stage: 'bm25', ids: ['b', 'd', 'a'] }

describe('fuseByRrf', () => {
  it('scores each id as the sum of 1/(k+rank) across the lists it appears in', () => {
    const fused = fuseByRrf([vector, bm25], { k: 60 })
    const score = (id: string) => fused.find((f) => f.id === id)!.rrfScore
    // a: vector rank 1, bm25 rank 3 -> 1/61 + 1/63
    expect(score('a')).toBeCloseTo(1 / 61 + 1 / 63, 12)
    // b: vector rank 2, bm25 rank 1 -> 1/62 + 1/61
    expect(score('b')).toBeCloseTo(1 / 62 + 1 / 61, 12)
    // c: vector rank 3 only -> 1/63
    expect(score('c')).toBeCloseTo(1 / 63, 12)
    // d: bm25 rank 2 only -> 1/62
    expect(score('d')).toBeCloseTo(1 / 62, 12)
  })

  it('ranks an id present in both lists above ids strong in only one', () => {
    const fused = fuseByRrf([vector, bm25], { k: 60 })
    // b appears in both (ranks 2 and 1); it should lead.
    expect(fused[0]?.id).toBe('b')
  })

  it('preserves each id provenance: which stage ranked it and at what rank', () => {
    const fused = fuseByRrf([vector, bm25], { k: 60 })
    const a = fused.find((f) => f.id === 'a')!
    expect(a.ranks).toEqual({ vector: 1, bm25: 3 })
    const c = fused.find((f) => f.id === 'c')!
    expect(c.ranks).toEqual({ vector: 3 })
  })

  it('returns ids in descending RRF score order', () => {
    const fused = fuseByRrf([vector, bm25], { k: 60 })
    const scores = fused.map((f) => f.rrfScore)
    const sorted = [...scores].sort((x, y) => y - x)
    expect(scores).toEqual(sorted)
  })

  it('breaks ties deterministically by id', () => {
    // Two single-list ids at the same rank tie on score; order is stable by id.
    const left: RankedList = { stage: 'vector', ids: ['zeta'] }
    const right: RankedList = { stage: 'bm25', ids: ['alpha'] }
    const fused = fuseByRrf([left, right], { k: 60 })
    expect(fused.map((f) => f.id)).toEqual(['alpha', 'zeta'])
  })

  it('handles lists with no overlap (union of all ids)', () => {
    const left: RankedList = { stage: 'vector', ids: ['a', 'b'] }
    const right: RankedList = { stage: 'bm25', ids: ['c', 'd'] }
    const fused = fuseByRrf([left, right], { k: 60 })
    expect(new Set(fused.map((f) => f.id))).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it('fuses an empty set of lists to an empty ranking', () => {
    expect(fuseByRrf([], { k: 60 })).toEqual([])
  })

  it('ignores empty lists', () => {
    const fused = fuseByRrf([vector, { stage: 'bm25', ids: [] }], { k: 60 })
    expect(fused.map((f) => f.id)).toEqual(['a', 'b', 'c'])
  })

  it('exposes a sane default k', () => {
    expect(RRF_K_DEFAULT).toBe(60)
    const withDefault = fuseByRrf([vector, bm25])
    const withExplicit = fuseByRrf([vector, bm25], { k: RRF_K_DEFAULT })
    expect(withDefault).toEqual(withExplicit)
  })
})
