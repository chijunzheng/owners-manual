import { citableUnitChunker } from '@owners-manual/enrichment'
import { describe, expect, it } from 'vitest'

import { chunkParsedDocuments, type CorpusChunk } from './chunk-corpus.js'

/** A tiny two-document parsed-corpus stand-in (tree + text sidecar). */
function fakeCorpus() {
  return [
    {
      documentId: 'doc-a',
      parsed: {
        tree: {
          kind: 'document' as const,
          documentId: 'doc-a',
          label: 'Doc A',
          children: [
            { kind: 'section' as const, label: '1', children: [] },
            { kind: 'section' as const, label: '2', children: [] },
          ],
        },
        text: new Map([
          ['doc-a|section:1', 'Section one operative text.'],
          ['doc-a|section:2', 'Section two operative text.'],
        ]),
      },
    },
    {
      documentId: 'doc-b',
      parsed: {
        tree: {
          kind: 'document' as const,
          documentId: 'doc-b',
          label: 'Doc B',
          children: [{ kind: 'section' as const, label: '1', children: [] }],
        },
        text: new Map([['doc-b|section:1', 'Doc B section one.']]),
      },
    },
  ]
}

describe('chunkParsedDocuments', () => {
  it('produces one chunk per text-bearing citable unit across all documents', () => {
    const chunks = chunkParsedDocuments(fakeCorpus(), citableUnitChunker)
    expect(chunks).toHaveLength(3)
  })

  it('tags every chunk with its document id and citable path', () => {
    const chunks = chunkParsedDocuments(fakeCorpus(), citableUnitChunker)
    const first = chunks.find((c) => c.text === 'Section one operative text.') as CorpusChunk
    expect(first.documentId).toBe('doc-a')
    expect(first.citablePathKey).toBe('doc-a|section:1')
    expect(first.id).toContain('citable-unit')
  })

  it('records the chunker id on every chunk so the build hash can move with it', () => {
    const chunks = chunkParsedDocuments(fakeCorpus(), citableUnitChunker)
    expect(chunks.every((c) => c.chunker === 'citable-unit')).toBe(true)
  })

  it('preserves document order then in-document order', () => {
    const chunks = chunkParsedDocuments(fakeCorpus(), citableUnitChunker)
    expect(chunks.map((c) => c.citablePathKey)).toEqual([
      'doc-a|section:1',
      'doc-a|section:2',
      'doc-b|section:1',
    ])
  })

  it('returns an empty list for an empty corpus', () => {
    expect(chunkParsedDocuments([], citableUnitChunker)).toEqual([])
  })
})
