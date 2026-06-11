import { describe, expect, it } from 'vitest'

import { selectSources } from './cli.js'
import type { Manifest, ManifestSource } from './manifest/schema.js'

function source(id: string): ManifestSource {
  return {
    id,
    title: `Title ${id}`,
    url: `https://example.test/${id}`,
    file: `${id}.txt`,
    sha256: 'a'.repeat(64),
    bytes: 1,
    consolidationDate: '2024-01-01',
    licence: { holder: "King's Printer for Ontario", note: 'n' },
    normalization: 'none',
  }
}

function manifestOf(...ids: string[]): Manifest {
  return {
    version: 1,
    generatedAt: '2026-06-09T00:00:00.000Z',
    sources: ids.map(source),
  }
}

describe('selectSources', () => {
  it('returns the manifest unchanged (same reference) when no ids are given', () => {
    const manifest = manifestOf('rta-2006', 'reg-516-06')
    expect(selectSources(manifest, [])).toBe(manifest)
  })

  it('narrows to a single named source', () => {
    const manifest = manifestOf('rta-2006', 'reg-516-06', 'rent-increase-guideline')
    const scoped = selectSources(manifest, ['rta-2006'])
    expect(scoped.sources.map((s) => s.id)).toEqual(['rta-2006'])
  })

  it('keeps manifest order regardless of the order ids are requested', () => {
    const manifest = manifestOf('a', 'b', 'c')
    const scoped = selectSources(manifest, ['c', 'a'])
    expect(scoped.sources.map((s) => s.id)).toEqual(['a', 'c'])
  })

  it('does not duplicate a source when an id is requested twice', () => {
    const manifest = manifestOf('a', 'b')
    const scoped = selectSources(manifest, ['a', 'a'])
    expect(scoped.sources.map((s) => s.id)).toEqual(['a'])
  })

  it('preserves the other manifest fields', () => {
    const manifest = manifestOf('a', 'b')
    const scoped = selectSources(manifest, ['a'])
    expect(scoped.version).toBe(manifest.version)
    expect(scoped.generatedAt).toBe(manifest.generatedAt)
  })

  it('does not mutate the input manifest', () => {
    const manifest = manifestOf('a', 'b')
    selectSources(manifest, ['a'])
    expect(manifest.sources.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('throws naming an unknown id and lists the known ids', () => {
    const manifest = manifestOf('rta-2006', 'reg-516-06')
    expect(() => selectSources(manifest, ['ghost'])).toThrow(/ghost/)
    expect(() => selectSources(manifest, ['ghost'])).toThrow(/rta-2006/)
  })

  it('names every unknown id when several are absent', () => {
    const manifest = manifestOf('rta-2006')
    expect(() => selectSources(manifest, ['ghost-a', 'ghost-b'])).toThrow(/ghost-a/)
    expect(() => selectSources(manifest, ['ghost-a', 'ghost-b'])).toThrow(/ghost-b/)
  })

  it('rejects the whole call when one id is known and another is not', () => {
    const manifest = manifestOf('rta-2006', 'reg-516-06')
    expect(() => selectSources(manifest, ['rta-2006', 'ghost'])).toThrow(/ghost/)
  })
})
