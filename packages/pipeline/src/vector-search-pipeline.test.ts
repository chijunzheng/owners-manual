import { describe, expect, it } from 'vitest'

import { buildTextSearchPipeline, buildVectorSearchPipeline } from './vector-search-pipeline.js'

describe('buildVectorSearchPipeline', () => {
  it('builds a $vectorSearch stage against the configured index and path', () => {
    const pipeline = buildVectorSearchPipeline({
      indexName: 'vector_voyage_law_2',
      queryVector: [0.1, 0.2],
      topK: 8,
    })
    const search = pipeline[0]?.$vectorSearch
    expect(search?.index).toBe('vector_voyage_law_2')
    expect(search?.path).toBe('embedding')
    expect(search?.queryVector).toEqual([0.1, 0.2])
    expect(search?.limit).toBe(8)
  })

  it('over-fetches candidates for ANN recall (numCandidates >= limit)', () => {
    const pipeline = buildVectorSearchPipeline({
      indexName: 'vector_voyage_law_2',
      queryVector: [0.1],
      topK: 8,
    })
    const search = pipeline[0]?.$vectorSearch
    expect(search?.numCandidates).toBeGreaterThanOrEqual(8)
  })

  it('projects the stored chunk fields plus the vectorSearchScore', () => {
    const pipeline = buildVectorSearchPipeline({
      indexName: 'i',
      queryVector: [0.1],
      topK: 1,
    })
    const project = pipeline[1]?.$project
    expect(project).toMatchObject({
      _id: 0,
      documentId: 1,
      citablePathKey: 1,
      text: 1,
      score: { $meta: 'vectorSearchScore' },
    })
  })

  it('emits no $vectorSearch.filter when no documentIds are supplied (#41)', () => {
    const pipeline = buildVectorSearchPipeline({
      indexName: 'i',
      queryVector: [0.1],
      topK: 1,
    })
    expect(pipeline[0]?.$vectorSearch?.filter).toBeUndefined()
  })

  it('emits an empty-set $vectorSearch.filter only when documentIds is non-empty (#41)', () => {
    // An empty allow-list is a no-op filter, never a $in:[] that drops everything.
    const pipeline = buildVectorSearchPipeline({
      indexName: 'i',
      queryVector: [0.1],
      topK: 1,
      documentIds: [],
    })
    expect(pipeline[0]?.$vectorSearch?.filter).toBeUndefined()
  })

  it('pushes a documentId $in pre-filter into $vectorSearch when documentIds are supplied (#41 AC1)', () => {
    const pipeline = buildVectorSearchPipeline({
      indexName: 'vector_voyage_law_2',
      queryVector: [0.1, 0.2],
      topK: 8,
      documentIds: ['rta-2006', 'reg-516-06'],
    })
    // ADR 0002 true pre-filter: the index declares documentId filterable, so the
    // allow-list rides INSIDE $vectorSearch (ANN restricted to allowed docs), not
    // a $match after the stage.
    expect(pipeline[0]?.$vectorSearch?.filter).toEqual({
      documentId: { $in: ['rta-2006', 'reg-516-06'] },
    })
  })
})

describe('buildTextSearchPipeline (#14 BM25 stage)', () => {
  it('builds a $search text stage against the configured index and query', () => {
    const pipeline = buildTextSearchPipeline({
      indexName: 'text_bm25',
      query: 'no pet clause void',
      topK: 8,
    })
    const search = pipeline[0]?.$search
    expect(search?.index).toBe('text_bm25')
    expect(search?.text?.query).toBe('no pet clause void')
    expect(search?.text?.path).toBe('text')
  })

  it('limits the BM25 results to topK', () => {
    const pipeline = buildTextSearchPipeline({ indexName: 'text_bm25', query: 'x', topK: 5 })
    const limit = pipeline.find((stage) => stage.$limit !== undefined)?.$limit
    expect(limit).toBe(5)
  })

  it('projects the stored chunk fields plus the BM25 searchScore', () => {
    const pipeline = buildTextSearchPipeline({ indexName: 'text_bm25', query: 'x', topK: 1 })
    const project = pipeline.find((stage) => stage.$project !== undefined)?.$project
    expect(project).toMatchObject({
      _id: 0,
      documentId: 1,
      citablePathKey: 1,
      text: 1,
      score: { $meta: 'searchScore' },
    })
  })

  it('keeps the bare text query (no compound) when no documentIds are supplied (#41)', () => {
    const pipeline = buildTextSearchPipeline({ indexName: 'text_bm25', query: 'x', topK: 1 })
    expect(pipeline[0]?.$search?.compound).toBeUndefined()
    expect(pipeline[0]?.$search?.text).toEqual({ query: 'x', path: 'text' })
  })

  it('keeps the bare text query when documentIds is empty (no-op filter) (#41)', () => {
    const pipeline = buildTextSearchPipeline({
      indexName: 'text_bm25',
      query: 'x',
      topK: 1,
      documentIds: [],
    })
    expect(pipeline[0]?.$search?.compound).toBeUndefined()
    expect(pipeline[0]?.$search?.text).toEqual({ query: 'x', path: 'text' })
  })

  it('wraps the text query in a $search compound.filter over documentId when supplied (#41 AC1)', () => {
    const pipeline = buildTextSearchPipeline({
      indexName: 'text_bm25',
      query: 'no pet clause void',
      topK: 8,
      documentIds: ['rta-2006', 'reg-516-06'],
    })
    const search = pipeline[0]?.$search
    // documentId is indexed as a token, so the pre-filter is a compound.filter
    // `in` clause while the BM25 query stays the scoring `must`.
    expect(search?.text).toBeUndefined()
    expect(search?.compound?.must).toEqual([
      { text: { query: 'no pet clause void', path: 'text' } },
    ])
    expect(search?.compound?.filter).toEqual([
      { in: { path: 'documentId', value: ['rta-2006', 'reg-516-06'] } },
    ])
  })
})
