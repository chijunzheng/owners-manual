import { describe, expect, it } from 'vitest'

import { bm25Rank, tokenize, type Bm25Document } from './bm25.js'

/**
 * BM25 is the lexical half of hybrid retrieval (#14): a deterministic Okapi
 * ranking over the chunk corpus, fused with the vector ranking by RRF. It is
 * pure (corpus + query in, ranked ids out) so the ranking is unit-tested offline
 * against fakes; the live BM25 stage is Atlas's `$search` text index, which this
 * mirrors closely enough that the harness's hit-rate triage is meaningful.
 *
 * The contract pinned here:
 *   - exact term overlap ranks a document above one with no overlap;
 *   - term-frequency saturation: more hits rank higher, but with diminishing
 *     returns (the BM25 `k1` saturation, not raw count);
 *   - IDF: a rare query term discriminates more than a corpus-ubiquitous one;
 *   - a query term absent from the whole corpus contributes nothing (no NaN);
 *   - ties and empties are handled deterministically.
 */

const corpus: readonly Bm25Document[] = [
  { id: 'pets-void', text: 'No pet provisions in a tenancy agreement are void.' },
  { id: 'repair', text: 'The landlord is responsible for the repair of the rental unit.' },
  { id: 'rent', text: 'A landlord must give ninety days notice to increase the rent.' },
  { id: 'deposit', text: 'The rent deposit is applied to the last rent period of the tenancy.' },
]

describe('tokenize', () => {
  it('lowercases and splits on non-word characters', () => {
    expect(tokenize('No-pet PROVISIONS, are void.')).toEqual([
      'no',
      'pet',
      'provisions',
      'are',
      'void',
    ])
  })

  it('returns an empty array for blank text', () => {
    expect(tokenize('   ')).toEqual([])
  })
})

describe('bm25Rank', () => {
  it('ranks a document sharing query terms above one that shares none', () => {
    const ranked = bm25Rank({ query: 'pet void clause', corpus, topK: 4 })
    expect(ranked[0]?.id).toBe('pets-void')
    // every returned hit has a finite, non-negative score
    for (const hit of ranked) {
      expect(Number.isFinite(hit.score)).toBe(true)
      expect(hit.score).toBeGreaterThanOrEqual(0)
    }
  })

  it('honours topK by truncating the ranked list', () => {
    const ranked = bm25Rank({ query: 'landlord rent', corpus, topK: 2 })
    expect(ranked).toHaveLength(2)
  })

  it('omits documents with zero overlap from the results', () => {
    const ranked = bm25Rank({ query: 'pet', corpus, topK: 4 })
    expect(ranked.map((r) => r.id)).toEqual(['pets-void'])
  })

  it('returns an empty ranking when no document overlaps the query', () => {
    const ranked = bm25Rank({ query: 'mortgage foreclosure', corpus, topK: 4 })
    expect(ranked).toEqual([])
  })

  it('returns an empty ranking for an empty query', () => {
    expect(bm25Rank({ query: '', corpus, topK: 4 })).toEqual([])
  })

  it('returns an empty ranking over an empty corpus', () => {
    expect(bm25Rank({ query: 'pet', corpus: [], topK: 4 })).toEqual([])
  })

  it('saturates term frequency: two hits beat one, but not linearly', () => {
    const tf: readonly Bm25Document[] = [
      { id: 'one', text: 'repair' },
      { id: 'two', text: 'repair repair' },
      { id: 'four', text: 'repair repair repair repair' },
    ]
    const ranked = bm25Rank({ query: 'repair', corpus: tf, topK: 3 })
    expect(ranked.map((r) => r.id)).toEqual(['four', 'two', 'one'])
    const score = (id: string) => ranked.find((r) => r.id === id)!.score
    // diminishing returns: going 1->2 gains more than 2->4 (saturation)
    expect(score('two') - score('one')).toBeGreaterThan(score('four') - score('two'))
  })

  it('weights a rarer query term above a corpus-ubiquitous one (IDF)', () => {
    // "landlord" appears in two docs; "deposit" in one. A doc matching the rare
    // term should outrank a doc matching only the common term.
    const rareHit = bm25Rank({ query: 'deposit', corpus, topK: 4 })[0]
    const commonHit = bm25Rank({ query: 'landlord', corpus, topK: 4 })[0]
    expect(rareHit?.score).toBeGreaterThan(commonHit?.score ?? Infinity)
  })

  it('is deterministic: identical inputs give identical scores and order', () => {
    const a = bm25Rank({ query: 'landlord repair rent', corpus, topK: 4 })
    const b = bm25Rank({ query: 'landlord repair rent', corpus, topK: 4 })
    expect(a).toEqual(b)
  })
})
