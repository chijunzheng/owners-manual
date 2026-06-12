import { describe, expect, it } from 'vitest'

import { type EmbeddingProvider } from './embedding.js'
import { retrieveTopK, type VectorSearchExecutor } from './retrieve.js'

/** A fake embedding provider returning a fixed query vector. */
const fakeProvider: EmbeddingProvider = {
  model: 'voyage-law-2',
  dimensions: 4,
  embedDocuments: async (texts) => texts.map(() => [0, 0, 0, 0]),
  embedQuery: async () => [0.1, 0.2, 0.3, 0.4],
}

/** A fake vector search returning two candidates in score order. */
const fakeSearch: VectorSearchExecutor = async ({ queryVector, topK }) => {
  expect(queryVector).toEqual([0.1, 0.2, 0.3, 0.4])
  return [
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
}

describe('retrieveTopK', () => {
  it('embeds the query and returns candidates tagged with the vector stage', async () => {
    const result = await retrieveTopK({
      question: 'who repairs the unit?',
      topK: 8,
      provider: fakeProvider,
      search: fakeSearch,
    })
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates[0]?.stage).toBe('vector')
    expect(result.candidates[0]?.documentId).toBe('rta-2006')
  })

  it('honours the requested top-k by passing it to the search executor', async () => {
    const result = await retrieveTopK({
      question: 'x',
      topK: 1,
      provider: fakeProvider,
      search: fakeSearch,
    })
    expect(result.candidates).toHaveLength(1)
  })

  it('parses each candidate citable-path key back into a structured CitablePath', async () => {
    const result = await retrieveTopK({
      question: 'x',
      topK: 8,
      provider: fakeProvider,
      search: fakeSearch,
    })
    const first = result.candidates[0]
    expect(first?.path.documentId).toBe('rta-2006')
    expect(first?.path.segments).toEqual([
      { kind: 'part', label: 'III' },
      { kind: 'section', label: '20' },
      { kind: 'subsection', label: '1' },
    ])
  })

  it('returns the query vector dimension for trace metadata', async () => {
    const result = await retrieveTopK({
      question: 'x',
      topK: 8,
      provider: fakeProvider,
      search: fakeSearch,
    })
    expect(result.queryDimensions).toBe(4)
  })

  it('returns an empty candidate list when search finds nothing', async () => {
    const result = await retrieveTopK({
      question: 'x',
      topK: 8,
      provider: fakeProvider,
      search: async () => [],
    })
    expect(result.candidates).toEqual([])
  })
})
