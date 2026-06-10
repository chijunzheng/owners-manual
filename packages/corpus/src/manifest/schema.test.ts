import { describe, expect, it } from 'vitest'

import { parseManifest } from './schema.js'

/**
 * A minimal, valid manifest entry reused across cases. Tests clone-and-mutate
 * this rather than sharing it, so no case can corrupt another's fixture.
 */
function validEntry() {
  return {
    id: 'rta-2006',
    title: 'Residential Tenancies Act, 2006, S.O. 2006, c. 17',
    url: 'https://www.ontario.ca/laws/statute/06r17',
    file: 'tenancy/rta-2006.html',
    sha256: 'a'.repeat(64),
    bytes: 1234,
    consolidationDate: '2024-01-01',
    licence: {
      holder: "King's Printer for Ontario",
      note: 'Reproduced under the King’s Printer for Ontario licence terms.',
    },
    normalization: 'none' as const,
  }
}

function validManifest() {
  return {
    version: 1,
    generatedAt: '2026-06-09T00:00:00.000Z',
    sources: [validEntry()],
  }
}

describe('parseManifest', () => {
  it('accepts a well-formed manifest and returns a typed value', () => {
    const result = parseManifest(validManifest())
    expect(result.version).toBe(1)
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]?.id).toBe('rta-2006')
    expect(result.sources[0]?.normalization).toBe('none')
  })

  it('records consolidation date and licence note per source', () => {
    const result = parseManifest(validManifest())
    const entry = result.sources[0]
    expect(entry?.consolidationDate).toBe('2024-01-01')
    expect(entry?.licence.holder).toBe("King's Printer for Ontario")
    expect(entry?.licence.note.length).toBeGreaterThan(0)
  })

  it('defaults normalization to "none" when omitted', () => {
    const entry = validEntry()
    delete (entry as Record<string, unknown>).normalization
    const result = parseManifest({ ...validManifest(), sources: [entry] })
    expect(result.sources[0]?.normalization).toBe('none')
  })

  it('rejects a non-object manifest', () => {
    expect(() => parseManifest(null)).toThrow(/manifest/i)
    expect(() => parseManifest('nope')).toThrow(/manifest/i)
  })

  it('rejects an empty sources list', () => {
    expect(() => parseManifest({ ...validManifest(), sources: [] })).toThrow(/at least one/i)
  })

  it('rejects a source missing required fields', () => {
    const entry = validEntry()
    delete (entry as Record<string, unknown>).url
    expect(() => parseManifest({ ...validManifest(), sources: [entry] })).toThrow(/url/i)
  })

  it('rejects a checksum that is not 64 lowercase hex chars', () => {
    expect(() =>
      parseManifest({ ...validManifest(), sources: [{ ...validEntry(), sha256: 'XYZ' }] }),
    ).toThrow(/sha256/i)
    expect(() =>
      parseManifest({ ...validManifest(), sources: [{ ...validEntry(), sha256: 'A'.repeat(64) }] }),
    ).toThrow(/sha256/i)
  })

  it('accepts the "strip-waf" normalization policy', () => {
    const result = parseManifest({
      ...validManifest(),
      sources: [{ ...validEntry(), normalization: 'strip-waf' }],
    })
    expect(result.sources[0]?.normalization).toBe('strip-waf')
  })

  it('rejects an unknown normalization policy', () => {
    expect(() =>
      parseManifest({
        ...validManifest(),
        sources: [{ ...validEntry(), normalization: 'rot13' }],
      }),
    ).toThrow(/normalization/i)
  })

  it('rejects a consolidation date that is not ISO YYYY-MM-DD', () => {
    expect(() =>
      parseManifest({
        ...validManifest(),
        sources: [{ ...validEntry(), consolidationDate: 'Jan 2024' }],
      }),
    ).toThrow(/consolidationDate/i)
  })

  it('rejects duplicate source ids', () => {
    expect(() =>
      parseManifest({ ...validManifest(), sources: [validEntry(), validEntry()] }),
    ).toThrow(/duplicate/i)
  })

  it('rejects negative or non-integer byte counts', () => {
    expect(() =>
      parseManifest({ ...validManifest(), sources: [{ ...validEntry(), bytes: -1 }] }),
    ).toThrow(/bytes/i)
    expect(() =>
      parseManifest({ ...validManifest(), sources: [{ ...validEntry(), bytes: 1.5 }] }),
    ).toThrow(/bytes/i)
  })
})
