import { describe, expect, it } from 'vitest'

import { type EmbeddingProvider } from './embedding.js'
import { type TextSearchExecutor } from './hybrid-retrieve.js'
import {
  handleRetrieveDebugRequest,
  parseRetrieveDebugRequest,
  type RetrieveDebugDeps,
} from './retrieve-debug.js'
import { type VectorSearchExecutor } from './retrieve.js'

/**
 * The retrieval-debug endpoint (#14 AC2; ADR 0003: "Retrieval-only metrics need
 * a debug endpoint on the TS service that exposes ranked chunks; this endpoint
 * is part of the contract, not a hack"). The Python harness drives the agent
 * arm's retrieval as a black box and reads candidates with their stage-
 * provenance to compute the pre-synthesis hit-rate and the hybrid-vs-vector
 * comparison — so the response MUST carry, per candidate, the path key (graded
 * hierarchically), every stage that found it, the per-stage ranks, the fused RRF
 * score, and the authority level.
 *
 * The handler is pure (providers injected) so it is unit-tested offline; the
 * thin serve-cli binds the live Atlas vector + BM25 executors around it.
 */

const provider: EmbeddingProvider = {
  model: 'voyage-law-2',
  dimensions: 4,
  embedDocuments: async (t) => t.map(() => [0, 0, 0, 0]),
  embedQuery: async () => [0.1, 0.2, 0.3, 0.4],
}

const vectorSearch: VectorSearchExecutor = async () => [
  {
    documentId: 'rta-2006',
    citablePathKey: 'rta-2006|part:II|section:14',
    text: 'No-pet provisions in a tenancy agreement are void.',
    score: 0.9,
  },
  {
    documentId: 'fixture-lease',
    citablePathKey: 'fixture-lease|section:pets|clause:p-1',
    text: 'No pets of any kind are permitted.',
    score: 0.6,
  },
]

const textSearch: TextSearchExecutor = async () => [
  {
    documentId: 'rta-2006',
    citablePathKey: 'rta-2006|part:II|section:14',
    text: 'No-pet provisions in a tenancy agreement are void.',
    score: 11.0,
  },
]

const deps: RetrieveDebugDeps = { provider, vectorSearch, textSearch, topK: 8 }

describe('parseRetrieveDebugRequest', () => {
  it('accepts a question and defaults the rest', () => {
    const req = parseRetrieveDebugRequest({ question: 'is my no-pet clause void?' })
    expect(req.question).toBe('is my no-pet clause void?')
  })

  it('accepts an optional topK and authority-level filter', () => {
    const req = parseRetrieveDebugRequest({
      question: 'q',
      topK: 3,
      authorityLevels: ['act', 'regulation'],
    })
    expect(req.topK).toBe(3)
    expect(req.authorityLevels).toEqual(['act', 'regulation'])
  })

  it('rejects a request with no question', () => {
    expect(() => parseRetrieveDebugRequest({ topK: 3 })).toThrow()
  })

  it('rejects an unknown authority level', () => {
    expect(() =>
      parseRetrieveDebugRequest({ question: 'q', authorityLevels: ['statute'] }),
    ).toThrow()
  })
})

describe('handleRetrieveDebugRequest — candidates with provenance tags (AC2)', () => {
  it('returns each candidate with its path key, stages, ranks, rrf score, authority', async () => {
    const response = await handleRetrieveDebugRequest({ question: 'no-pet clause?' }, deps)
    const top = response.candidates[0]!
    expect(top.citablePathKey).toBe('rta-2006|part:II|section:14')
    // found by both stages -> hybrid, with both ranks
    expect(top.stage).toBe('hybrid')
    expect(top.stages).toEqual(expect.arrayContaining(['vector', 'bm25']))
    expect(top.stageRanks.vector).toBe(1)
    expect(top.stageRanks.bm25).toBe(1)
    expect(top.rrfScore).toBeGreaterThan(0)
    expect(top.authorityLevel).toBe('act')
  })

  it('echoes the question and the candidate count', async () => {
    const response = await handleRetrieveDebugRequest({ question: 'no-pet clause?' }, deps)
    expect(response.question).toBe('no-pet clause?')
    expect(response.candidateCount).toBe(response.candidates.length)
    expect(response.candidateCount).toBe(2)
  })

  it('reports the query embedding dimension', async () => {
    const response = await handleRetrieveDebugRequest({ question: 'q' }, deps)
    expect(response.queryDimensions).toBe(4)
  })

  it('honours a per-request topK override', async () => {
    const response = await handleRetrieveDebugRequest({ question: 'q', topK: 1 }, deps)
    expect(response.candidates).toHaveLength(1)
  })

  it('applies the authority-level filter (ADR 0002 metadata pre-filter)', async () => {
    const response = await handleRetrieveDebugRequest(
      { question: 'q', authorityLevels: ['act'] },
      deps,
    )
    expect(response.candidates.every((c) => c.authorityLevel === 'act')).toBe(true)
    // the contract-level lease clause is filtered out
    expect(response.candidates.map((c) => c.documentId)).not.toContain('fixture-lease')
  })

  it('returns a JSON-serializable response (no Map/undefined surprises)', async () => {
    const response = await handleRetrieveDebugRequest({ question: 'q' }, deps)
    const round = JSON.parse(JSON.stringify(response))
    expect(round.candidates[0].citablePathKey).toBe('rta-2006|part:II|section:14')
    expect(round.candidates[0].stageRanks.vector).toBe(1)
  })
})

describe('handleRetrieveDebugRequest — true pre-filter wiring (#41 AC2)', () => {
  // The call site resolves authorityLevels -> a documentId allow-list from the
  // corpus's KNOWN id set (injected by serve-cli from the manifest / fixture
  // registry) and threads it into the executors as a true pre-filter.
  const corpusDocumentIds = ['rta-2006', 'reg-516-06', 'fixture-lease', 'fixture-declaration']

  it('resolves the authority levels to documentIds and pushes them into both executors', async () => {
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
    await handleRetrieveDebugRequest(
      { question: 'q', authorityLevels: ['act'] },
      {
        provider,
        vectorSearch: captureVector,
        textSearch: captureText,
        topK: 8,
        corpusDocumentIds,
      },
    )
    // 'act' resolves to rta-2006 only, out of the known corpus id set.
    expect(vectorArg).toEqual(['rta-2006'])
    expect(textArg).toEqual(['rta-2006'])
  })

  it('threads no pre-filter when the request omits authorityLevels', async () => {
    let vectorArg: readonly string[] | undefined = ['unset']
    const captureVector: VectorSearchExecutor = async ({ documentIds }) => {
      vectorArg = documentIds
      return []
    }
    await handleRetrieveDebugRequest(
      { question: 'q' },
      { provider, vectorSearch: captureVector, textSearch, topK: 8, corpusDocumentIds },
    )
    expect(vectorArg).toBeUndefined()
  })

  it('threads no pre-filter when no corpus id set is injected (still post-filters)', async () => {
    // Without a known id set the inverse cannot be computed, so the pre-filter is
    // skipped and only the post-fusion authority guard runs — never a hardcoded list.
    let vectorArg: readonly string[] | undefined = ['unset']
    const captureVector: VectorSearchExecutor = async ({ documentIds }) => {
      vectorArg = documentIds
      return []
    }
    await handleRetrieveDebugRequest(
      { question: 'q', authorityLevels: ['act'] },
      { provider, vectorSearch: captureVector, textSearch, topK: 8 },
    )
    expect(vectorArg).toBeUndefined()
  })
})

describe('handleRetrieveDebugRequest — vector-only mode (isolates the BM25+RRF lift)', () => {
  it('defaults to hybrid mode', async () => {
    const response = await handleRetrieveDebugRequest({ question: 'q' }, deps)
    expect(response.mode).toBe('hybrid')
  })

  it('runs vector-only when mode=vector, tagging every candidate vector', async () => {
    const response = await handleRetrieveDebugRequest({ question: 'q', mode: 'vector' }, deps)
    expect(response.mode).toBe('vector')
    expect(response.candidates.every((c) => c.stage === 'vector')).toBe(true)
    // The BM25-only candidate cannot appear in vector-only mode.
    expect(response.candidates.map((c) => c.documentId)).toContain('rta-2006')
  })

  it('vector-only and hybrid run over the SAME chunks, differing only in fusion', async () => {
    // Both modes see the same vector hits; hybrid additionally fuses BM25. So the
    // vector-only candidate set is a subset of (or equal to) the hybrid union.
    const vector = await handleRetrieveDebugRequest({ question: 'q', mode: 'vector' }, deps)
    const hybrid = await handleRetrieveDebugRequest({ question: 'q', mode: 'hybrid' }, deps)
    const vectorKeys = new Set(vector.candidates.map((c) => c.citablePathKey))
    const hybridKeys = new Set(hybrid.candidates.map((c) => c.citablePathKey))
    for (const key of vectorKeys) expect(hybridKeys.has(key)).toBe(true)
  })

  it('parseRetrieveDebugRequest accepts mode and rejects an unknown one', () => {
    expect(parseRetrieveDebugRequest({ question: 'q', mode: 'vector' }).mode).toBe('vector')
    expect(() => parseRetrieveDebugRequest({ question: 'q', mode: 'graph' })).toThrow()
  })
})
