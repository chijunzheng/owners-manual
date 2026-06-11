import { describe, expect, it } from 'vitest'

import type { ParsedDocument } from '@owners-manual/parser'

import { citableUnitChunker, hashChunk, type Chunk, type Chunker } from './chunk.js'

/**
 * The chunker interface is the seam the hierarchy chunker (#14) will satisfy.
 * ADR 0004 pins its contract: chunk boundaries coincide with citable units
 * produced by deterministic tree traversal. Chunk-level enrichment keys to the
 * chunk *hash* (+ prompt version), so the only thing this slice needs from a
 * chunker is: a tree in, a list of stably-identified, text-bearing chunks out.
 *
 * `citableUnitChunker` is a minimal reference implementation against that
 * interface — NOT the real #14 chunker. It exists so the cache-keying and
 * invalidation behavior is assertable offline before #14 lands, and so swapping
 * in a different chunker can be shown to invalidate chunk-level enrichment only.
 */

const parsed = (documentId: string, text: Array<[string, string]>): ParsedDocument => ({
  tree: {
    kind: 'document',
    label: documentId,
    documentId,
    children: text.map(([key]) => ({
      kind: 'section' as const,
      label: key.split(':').pop() ?? key,
      children: [],
    })),
  },
  text: new Map(text),
})

const sample = parsed('RTA', [
  ['RTA|section:1', 'The purposes of this Act are to provide protection.'],
  ['RTA|section:2', 'In this Act, "Board" means the Landlord and Tenant Board.'],
])

describe('citableUnitChunker', () => {
  it('satisfies the Chunker interface', () => {
    const chunker: Chunker = citableUnitChunker
    expect(typeof chunker.id).toBe('string')
    expect(typeof chunker.chunk).toBe('function')
  })

  it('emits one chunk per text-bearing citable unit, in document order', () => {
    const chunks = citableUnitChunker.chunk(sample)
    expect(chunks.map((c) => c.citablePathKey)).toEqual(['RTA|section:1', 'RTA|section:2'])
    expect(chunks.map((c) => c.text)).toEqual([
      'The purposes of this Act are to provide protection.',
      'In this Act, "Board" means the Landlord and Tenant Board.',
    ])
  })

  it('gives every chunk a stable id derived from its citable path', () => {
    const first = citableUnitChunker.chunk(sample)
    const second = citableUnitChunker.chunk(sample)
    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id))
  })
})

describe('hashChunk', () => {
  it('returns a lowercase 64-char hex digest', () => {
    const [chunk] = citableUnitChunker.chunk(sample)
    expect(hashChunk(chunk as Chunk)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is identical for two chunks with the same id and text', () => {
    const a: Chunk = { id: 'x', citablePathKey: 'RTA|section:1', text: 'same' }
    const b: Chunk = { id: 'x', citablePathKey: 'RTA|section:1', text: 'same' }
    expect(hashChunk(a)).toBe(hashChunk(b))
  })

  it('changes when the chunk text changes', () => {
    const a: Chunk = { id: 'x', citablePathKey: 'RTA|section:1', text: 'shall' }
    const b: Chunk = { id: 'x', citablePathKey: 'RTA|section:1', text: 'will' }
    expect(hashChunk(a)).not.toBe(hashChunk(b))
  })

  it('changes when the citable path changes even if text is identical', () => {
    const a: Chunk = { id: 'x', citablePathKey: 'RTA|section:1', text: 'same' }
    const b: Chunk = { id: 'x', citablePathKey: 'RTA|section:2', text: 'same' }
    expect(hashChunk(a)).not.toBe(hashChunk(b))
  })
})
