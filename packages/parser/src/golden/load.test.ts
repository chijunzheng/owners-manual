import { describe, expect, it } from 'vitest'

import { GOLDEN_CATEGORIES, parseGoldenItem } from './load.js'

/**
 * The golden-item schema is strict so a malformed extraction item fails loudly
 * at load time rather than silently weakening the extraction gate. A valid item
 * carries a known category, a non-empty provenance and licence, and a
 * schema-valid expected tree.
 */
const valid = {
  id: 'sample',
  category: 'definitions' as const,
  provenance: 'hand-verified sample',
  licence: 'Statute text © King’s Printer for Ontario.',
  sourceFile: 'sample.source.html',
  documentId: 'RTA',
  title: 'Residential Tenancies Act, 2006',
  expectedTree: {
    kind: 'document',
    documentId: 'RTA',
    label: 'Residential Tenancies Act, 2006',
    children: [{ kind: 'section', label: '1', children: [] }],
  },
  expectedText: { 'RTA|section:1': 'The purposes.' },
}

describe('parseGoldenItem', () => {
  it('exposes the hard-section categories it covers', () => {
    expect(GOLDEN_CATEGORIES).toContain('definitions')
    expect(GOLDEN_CATEGORIES).toContain('repealed-marker')
    expect(GOLDEN_CATEGORIES).toContain('embedded-table')
  })

  it('accepts a well-formed item', () => {
    expect(() => parseGoldenItem(valid)).not.toThrow()
  })

  it('rejects an unknown category', () => {
    expect(() => parseGoldenItem({ ...valid, category: 'mystery' })).toThrow()
  })

  it('rejects an item missing its provenance', () => {
    const withoutProvenance: Record<string, unknown> = { ...valid }
    delete withoutProvenance.provenance
    expect(() => parseGoldenItem(withoutProvenance)).toThrow()
  })

  it('rejects an expected tree that is not schema-valid', () => {
    const bad = { ...valid, expectedTree: { ...valid.expectedTree, kind: 'section' } }
    expect(() => parseGoldenItem(bad)).toThrow()
  })

  it('rejects an unknown extra key (strict schema)', () => {
    expect(() => parseGoldenItem({ ...valid, surprise: true })).toThrow()
  })
})
