import { describe, expect, it } from 'vitest'

import type { ParsedDocument } from '@owners-manual/parser'

import { hashTree } from './tree-hash.js'

/**
 * The tree hash is the cache key for tree-level enrichment (ADR 0004): keyed to
 * the tree hash so it survives chunker changes. It must therefore be a stable,
 * canonical fingerprint of the parsed document's *structure and operative text*
 * — and nothing about how that document is later chunked. These tests pin the
 * properties the cache depends on: determinism, sensitivity to structure/text,
 * and order-independence of the text sidecar map.
 */

const tree = (documentId: string, children: unknown[] = []) => ({
  kind: 'document' as const,
  label: documentId,
  documentId,
  children: children as never,
})

const doc = (
  documentId: string,
  text: Array<[string, string]>,
  children: unknown[] = [],
): ParsedDocument => ({
  tree: tree(documentId, children),
  text: new Map(text),
})

describe('hashTree', () => {
  it('returns a lowercase 64-char hex digest', () => {
    const digest = hashTree(doc('RTA', [['RTA|section:1', 'The purposes of this Act']]))
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic across calls for the same parse', () => {
    const parsed = doc('RTA', [['RTA|section:1', 'a']])
    expect(hashTree(parsed)).toBe(hashTree(parsed))
  })

  it('is independent of the text-map insertion order', () => {
    const a = doc('RTA', [
      ['RTA|section:1', 'first'],
      ['RTA|section:2', 'second'],
    ])
    const b = doc('RTA', [
      ['RTA|section:2', 'second'],
      ['RTA|section:1', 'first'],
    ])
    expect(hashTree(a)).toBe(hashTree(b))
  })

  it('changes when a node label changes', () => {
    const a = doc('RTA', [], [{ kind: 'section', label: '1', children: [] }])
    const b = doc('RTA', [], [{ kind: 'section', label: '2', children: [] }])
    expect(hashTree(a)).not.toBe(hashTree(b))
  })

  it('changes when operative text changes', () => {
    const a = doc('RTA', [['RTA|section:1', 'shall']])
    const b = doc('RTA', [['RTA|section:1', 'will']])
    expect(hashTree(a)).not.toBe(hashTree(b))
  })

  it('changes when the document id changes', () => {
    expect(hashTree(doc('RTA', []))).not.toBe(hashTree(doc('CONDO', [])))
  })
})
