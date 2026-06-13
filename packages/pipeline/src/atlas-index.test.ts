import { describe, expect, it, vi } from 'vitest'

import {
  BM25_TEXT_INDEX_NAME,
  buildTextSearchIndexDefinition,
  buildVectorIndexDefinition,
  ensureSearchIndex,
  ensureVectorIndex,
  type SearchIndexCollection,
} from './atlas-index.js'

describe('buildVectorIndexDefinition', () => {
  it('defines a single vectorSearch index with the configured name and dimensions', () => {
    const def = buildVectorIndexDefinition({
      name: 'vector_voyage_law_2',
      path: 'embedding',
      dimensions: 1024,
    })
    expect(def.name).toBe('vector_voyage_law_2')
    expect(def.type).toBe('vectorSearch')
    const field = def.definition.fields[0]
    expect(field).toMatchObject({
      type: 'vector',
      path: 'embedding',
      numDimensions: 1024,
      similarity: 'cosine',
    })
  })

  it('declares documentId as a filterable field for corpus pre-filtering', () => {
    const def = buildVectorIndexDefinition({
      name: 'vector_voyage_law_2',
      path: 'embedding',
      dimensions: 1024,
    })
    const filter = def.definition.fields.find((f) => f.type === 'filter')
    expect(filter?.path).toBe('documentId')
  })
})

describe('ensureVectorIndex', () => {
  it('creates the index when it does not yet exist', async () => {
    const created: unknown[] = []
    const collection: SearchIndexCollection = {
      listSearchIndexes: () => ({ toArray: async () => [] }),
      createSearchIndex: async (def) => {
        created.push(def)
        return def.name
      },
    }
    const result = await ensureVectorIndex(collection, {
      name: 'vector_voyage_law_2',
      path: 'embedding',
      dimensions: 1024,
    })
    expect(result.created).toBe(true)
    expect(created).toHaveLength(1)
  })

  it('is idempotent: does not recreate an index of the same name', async () => {
    const create = vi.fn()
    const collection: SearchIndexCollection = {
      listSearchIndexes: () => ({ toArray: async () => [{ name: 'vector_voyage_law_2' }] }),
      createSearchIndex: create,
    }
    const result = await ensureVectorIndex(collection, {
      name: 'vector_voyage_law_2',
      path: 'embedding',
      dimensions: 1024,
    })
    expect(result.created).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })
})

describe('buildTextSearchIndexDefinition (#14 BM25 stage)', () => {
  it('defines a `search` index (not vectorSearch) for the BM25 lexical stage', () => {
    const def = buildTextSearchIndexDefinition()
    expect(def.type).toBe('search')
    expect(def.name).toBe(BM25_TEXT_INDEX_NAME)
  })

  it('indexes the chunk text as a string field so BM25 can score it', () => {
    const def = buildTextSearchIndexDefinition()
    expect(def.definition.mappings.fields.text).toMatchObject({ type: 'string' })
  })

  it('declares documentId filterable for corpus/authority pre-filtering (ADR 0002)', () => {
    const def = buildTextSearchIndexDefinition()
    // documentId is kept as a token/string facet so $search can pre-filter.
    expect(def.definition.mappings.fields.documentId).toBeDefined()
  })

  it('uses a name distinct from the vector index (M0 three-index cap)', () => {
    expect(BM25_TEXT_INDEX_NAME).not.toBe('vector_voyage_law_2')
  })
})

describe('ensureSearchIndex (generic, covers both vector and text)', () => {
  it('creates a text index when absent', async () => {
    const created: unknown[] = []
    const collection: SearchIndexCollection = {
      listSearchIndexes: () => ({ toArray: async () => [] }),
      createSearchIndex: async (def) => {
        created.push(def)
        return def.name
      },
    }
    const result = await ensureSearchIndex(collection, buildTextSearchIndexDefinition())
    expect(result.created).toBe(true)
    expect(result.name).toBe(BM25_TEXT_INDEX_NAME)
  })

  it('is idempotent for the text index too', async () => {
    const create = vi.fn()
    const collection: SearchIndexCollection = {
      listSearchIndexes: () => ({ toArray: async () => [{ name: BM25_TEXT_INDEX_NAME }] }),
      createSearchIndex: create,
    }
    const result = await ensureSearchIndex(collection, buildTextSearchIndexDefinition())
    expect(result.created).toBe(false)
    expect(create).not.toHaveBeenCalled()
  })
})
