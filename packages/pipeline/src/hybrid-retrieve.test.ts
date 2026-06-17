import { describe, expect, it } from 'vitest'

import { type EmbeddingProvider } from './embedding.js'
import { retrieveHybrid, type TextSearchExecutor } from './hybrid-retrieve.js'
import { type VectorSearchExecutor } from './retrieve.js'

/**
 * Hybrid retrieval (#14): embed the question, run Atlas vector search AND a BM25
 * text search, fuse the two rankings by RRF, and return candidates each tagged
 * with stage-provenance (vector rank, BM25 rank, fused RRF score) and authority
 * level. ADR 0002: vector + BM25 with metadata pre-filtering on corpus AND
 * authority level in one query path. The naive-rag arm is untouched — this is a
 * NEW path alongside `retrieveTopK`.
 *
 * Both search executors are injected (mirroring `retrieveTopK`) so the fusion,
 * provenance tagging, authority classification, and filtering are unit-tested
 * offline; the live Atlas `$vectorSearch` and `$search` aggregations bind in the
 * Mongo store.
 */

const provider: EmbeddingProvider = {
  model: 'voyage-law-2',
  dimensions: 4,
  embedDocuments: async (texts) => texts.map(() => [0, 0, 0, 0]),
  embedQuery: async () => [0.1, 0.2, 0.3, 0.4],
}

/** Vector stage ranks the repair section first, then the no-pets clause. */
const vectorSearch: VectorSearchExecutor = async ({ topK }) =>
  [
    {
      documentId: 'rta-2006',
      citablePathKey: 'rta-2006|part:III|section:20|subsection:1',
      text: 'The landlord must keep the unit in a good state of repair.',
      score: 0.91,
    },
    {
      documentId: 'rta-2006',
      citablePathKey: 'rta-2006|part:II|section:14',
      text: 'No-pet provisions in a tenancy agreement are void.',
      score: 0.77,
    },
  ].slice(0, topK)

/** BM25 stage ranks the no-pets clause first (lexical "pet" match), then a reg. */
const textSearch: TextSearchExecutor = async ({ topK }) =>
  [
    {
      documentId: 'rta-2006',
      citablePathKey: 'rta-2006|part:II|section:14',
      text: 'No-pet provisions in a tenancy agreement are void.',
      score: 12.3,
    },
    {
      documentId: 'reg-516-06',
      citablePathKey: 'reg-516-06|section:17',
      text: 'Prescribed exemptions for prohibited charges.',
      score: 8.1,
    },
  ].slice(0, topK)

const base = {
  question: 'is my no-pet clause void?',
  topK: 8,
  provider,
  vectorSearch,
  textSearch,
}

describe('retrieveHybrid — fusion and shape', () => {
  it('returns the union of vector and BM25 candidates', async () => {
    const result = await retrieveHybrid(base)
    const keys = result.candidates.map((c) => c.citablePathKey).sort()
    expect(keys).toEqual(
      [
        'rta-2006|part:III|section:20|subsection:1',
        'rta-2006|part:II|section:14',
        'reg-516-06|section:17',
      ].sort(),
    )
  })

  it('orders candidates by fused RRF score (agreement wins)', async () => {
    const result = await retrieveHybrid(base)
    // s.14 is ranked by BOTH stages (vector rank 2, bm25 rank 1) so it leads.
    expect(result.candidates[0]?.citablePathKey).toBe('rta-2006|part:II|section:14')
    const scores = result.candidates.map((c) => c.score)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
  })

  it('honours topK after fusion', async () => {
    const result = await retrieveHybrid({ ...base, topK: 2 })
    expect(result.candidates).toHaveLength(2)
  })

  it('reports the query embedding dimension for trace metadata', async () => {
    const result = await retrieveHybrid(base)
    expect(result.queryDimensions).toBe(4)
  })
})

describe('retrieveHybrid — stage provenance tags (AC2: candidates carry provenance)', () => {
  it('tags a candidate found by both stages as hybrid with both ranks', async () => {
    const result = await retrieveHybrid(base)
    const s14 = result.candidates.find((c) => c.citablePathKey === 'rta-2006|part:II|section:14')!
    expect(s14.stage).toBe('hybrid')
    expect(s14.stages).toEqual(expect.arrayContaining(['vector', 'bm25']))
    expect(s14.stageRanks).toEqual({ vector: 2, bm25: 1 })
    expect(s14.rrfScore).toBeGreaterThan(0)
  })

  it('tags a vector-only candidate with the vector stage and rank', async () => {
    const result = await retrieveHybrid(base)
    const repair = result.candidates.find(
      (c) => c.citablePathKey === 'rta-2006|part:III|section:20|subsection:1',
    )!
    expect(repair.stage).toBe('vector')
    expect(repair.stages).toEqual(['vector'])
    expect(repair.stageRanks).toEqual({ vector: 1 })
  })

  it('tags a BM25-only candidate with the bm25 stage and rank', async () => {
    const result = await retrieveHybrid(base)
    const reg = result.candidates.find((c) => c.citablePathKey === 'reg-516-06|section:17')!
    expect(reg.stage).toBe('bm25')
    expect(reg.stages).toEqual(['bm25'])
    // The reg is the SECOND hit in the BM25 list, so its bm25 rank is 2 — the
    // candidate carries the rank the stage actually gave it, not a reset.
    expect(reg.stageRanks).toEqual({ bm25: 2 })
  })

  it('parses each candidate path key back into a structured CitablePath', async () => {
    const result = await retrieveHybrid(base)
    const s14 = result.candidates.find((c) => c.citablePathKey === 'rta-2006|part:II|section:14')!
    expect(s14.path.documentId).toBe('rta-2006')
    expect(s14.path.segments).toEqual([
      { kind: 'part', label: 'II' },
      { kind: 'section', label: '14' },
    ])
  })

  it('tags each candidate with its authority level', async () => {
    const result = await retrieveHybrid(base)
    const act = result.candidates.find((c) => c.documentId === 'rta-2006')!
    const reg = result.candidates.find((c) => c.documentId === 'reg-516-06')!
    expect(act.authorityLevel).toBe('act')
    expect(reg.authorityLevel).toBe('regulation')
  })
})

describe('retrieveHybrid — authority-level metadata filter', () => {
  it('keeps only candidates at the allowed authority levels when filtered', async () => {
    const result = await retrieveHybrid({ ...base, authorityLevels: ['act'] })
    expect(result.candidates.every((c) => c.authorityLevel === 'act')).toBe(true)
    expect(result.candidates.map((c) => c.documentId)).not.toContain('reg-516-06')
  })

  it('returns all candidates when no authority filter is given', async () => {
    const result = await retrieveHybrid(base)
    expect(result.candidates.length).toBe(3)
  })
})

describe('retrieveHybrid — true PRE-filter pushed into the stages (#41)', () => {
  it('threads the resolved documentIds allow-list into BOTH executors (AC2)', async () => {
    let vectorArg: readonly string[] | undefined = ['unset']
    let textArg: readonly string[] | undefined = ['unset']
    const captureVector: VectorSearchExecutor = async ({ documentIds }) => {
      vectorArg = documentIds
      return []
    }
    const captureText: TextSearchExecutor = async ({ documentIds }) => {
      textArg = documentIds
      return []
    }
    await retrieveHybrid({
      ...base,
      vectorSearch: captureVector,
      textSearch: captureText,
      authorityLevels: ['act'],
      // The resolved allow-list (the call site does authorityLevels -> ids).
      documentFilter: ['rta-2006'],
    })
    expect(vectorArg).toEqual(['rta-2006'])
    expect(textArg).toEqual(['rta-2006'])
  })

  it('passes no documentIds to the executors when no documentFilter is supplied', async () => {
    let vectorArg: readonly string[] | undefined = ['unset']
    const captureVector: VectorSearchExecutor = async ({ documentIds }) => {
      vectorArg = documentIds
      return []
    }
    await retrieveHybrid({ ...base, vectorSearch: captureVector })
    expect(vectorArg).toBeUndefined()
  })
})

describe('retrieveHybrid — AC3 regression: high-authority chunk no longer crowded out', () => {
  // The core bug (#41). The vector stage ranks MORE THAN perStageK lower-authority
  // (contract) chunks above the one high-authority (act) chunk the caller wants.
  // perStageK = topK(2) * factor(2) = 4, so with five contract chunks ranked first
  // the lone act chunk sits at rank 6 — outside the over-fetch window. Under the
  // OLD post-fusion filter the act chunk is never fetched, so an authorityLevels:
  // ['act'] request returns NOTHING. The true pre-filter restricts the stage to
  // allowed documents, so the act chunk is fetched and returned.
  const CONTRACT_KEYS = [1, 2, 3, 4, 5].map((n) => `fixture-lease|section:s${n}|clause:p-1`)
  const ACT_KEY = 'rta-2006|part:II|section:14'

  /** A vector executor that honours the documentIds pre-filter, as Atlas would. */
  const crowdingVector: VectorSearchExecutor = async ({ topK, documentIds }) => {
    const allow = documentIds ? new Set(documentIds) : undefined
    const rows = [
      ...CONTRACT_KEYS.map((key) => ({
        documentId: 'fixture-lease',
        citablePathKey: key,
        text: 'A lease clause about the unit.',
        score: 0.9,
      })),
      {
        documentId: 'rta-2006',
        citablePathKey: ACT_KEY,
        text: 'A provision prohibiting animals in a tenancy agreement is void.',
        score: 0.5,
      },
    ]
    const filtered = allow ? rows.filter((r) => allow.has(r.documentId)) : rows
    return filtered.slice(0, topK)
  }

  const crowdingBase = {
    question: 'is my no-pet clause void?',
    topK: 2,
    perStageFactor: 2,
    provider,
    vectorSearch: crowdingVector,
    textSearch: (async () => []) as TextSearchExecutor,
  }

  it('drops the high-authority chunk WITHOUT the pre-filter (the bug being fixed)', async () => {
    // No documentFilter: the executor over-fetches perStageK=4 contract chunks, the
    // act chunk at rank 6 is never returned, and the post-fusion authority filter
    // has nothing to keep.
    const result = await retrieveHybrid({ ...crowdingBase, authorityLevels: ['act'] })
    expect(result.candidates.map((c) => c.citablePathKey)).not.toContain(ACT_KEY)
    expect(result.candidates).toHaveLength(0)
  })

  it('returns the high-authority chunk WITH the pre-filter threaded (AC3 fix)', async () => {
    const result = await retrieveHybrid({
      ...crowdingBase,
      authorityLevels: ['act'],
      documentFilter: ['rta-2006'],
    })
    expect(result.candidates.map((c) => c.citablePathKey)).toContain(ACT_KEY)
    expect(result.candidates.every((c) => c.authorityLevel === 'act')).toBe(true)
  })
})

describe('retrieveHybrid — AC4 belt-and-suspenders post-fusion guard retained', () => {
  // Even if the pre-filter is bypassed (a stale documentFilter, an executor that
  // ignores it, or none threaded), no candidate at a disallowed authority level
  // may escape. Here the executors return a regulation chunk the documentFilter
  // did NOT permit; the post-fusion allow-list must still drop it.
  const leakyVector: VectorSearchExecutor = async () => [
    {
      documentId: 'rta-2006',
      citablePathKey: 'rta-2006|part:II|section:14',
      text: 'A provision prohibiting animals is void.',
      score: 0.9,
    },
    {
      documentId: 'reg-516-06',
      citablePathKey: 'reg-516-06|section:17',
      text: 'Prescribed exemptions for prohibited charges.',
      score: 0.8,
    },
  ]

  it('still drops a disallowed-level candidate the pre-filter let slip through', async () => {
    const result = await retrieveHybrid({
      ...base,
      vectorSearch: leakyVector,
      textSearch: async () => [],
      authorityLevels: ['act'],
      // documentFilter only permits the act doc, but the leaky executor ignored it.
      documentFilter: ['rta-2006'],
    })
    expect(result.candidates.map((c) => c.documentId)).not.toContain('reg-516-06')
    expect(result.candidates.every((c) => c.authorityLevel === 'act')).toBe(true)
  })
})

describe('retrieveHybrid — degenerate inputs', () => {
  it('returns vector-only candidates when BM25 finds nothing', async () => {
    const result = await retrieveHybrid({ ...base, textSearch: async () => [] })
    expect(result.candidates.length).toBe(2)
    expect(result.candidates.every((c) => c.stage === 'vector')).toBe(true)
  })

  it('returns BM25-only candidates when vector finds nothing', async () => {
    const result = await retrieveHybrid({ ...base, vectorSearch: async () => [] })
    expect(result.candidates.every((c) => c.stage === 'bm25')).toBe(true)
  })

  it('returns an empty candidate set when both stages find nothing', async () => {
    const result = await retrieveHybrid({
      ...base,
      vectorSearch: async () => [],
      textSearch: async () => [],
    })
    expect(result.candidates).toEqual([])
  })
})
