import { describe, expect, it } from 'vitest'

import { buildVectorSearchPipeline } from './vector-search-pipeline.js'

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
})
