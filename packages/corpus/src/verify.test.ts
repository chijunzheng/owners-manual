import { describe, expect, it } from 'vitest'

import { checksum } from './hash.js'
import { verifyManifest } from './verify.js'
import type { ByteSource } from './verify.js'
import type { Manifest, ManifestSource } from './manifest/schema.js'

const enc = (s: string) => new TextEncoder().encode(s)

/**
 * Builds a manifest whose recorded checksums match the supplied content map,
 * so a faithful byte source verifies clean. Tests then perturb either side to
 * exercise the failure paths.
 */
function manifestFor(content: Record<string, { text: string; normalization?: 'none' | 'crlf-to-lf' }>): {
  manifest: Manifest
  source: ByteSource
} {
  const sources: ManifestSource[] = Object.entries(content).map(([id, { text, normalization }]) => {
    const policy = normalization ?? 'none'
    const { sha256, bytes } = checksum(enc(text), policy)
    return {
      id,
      title: `Title for ${id}`,
      url: `https://example.test/${id}`,
      file: `${id}.txt`,
      sha256,
      bytes,
      consolidationDate: '2024-01-01',
      licence: { holder: "King's Printer for Ontario", note: 'test licence' },
      normalization: policy,
    }
  })

  const bytesById = new Map(Object.entries(content).map(([id, { text }]) => [id, enc(text)]))
  const source: ByteSource = {
    read: async (s) => {
      const found = bytesById.get(s.id)
      if (!found) throw new Error(`no fixture bytes for ${s.id}`)
      return found
    },
  }

  return { manifest: { version: 1, generatedAt: '2026-06-09T00:00:00.000Z', sources }, source }
}

describe('verifyManifest', () => {
  it('reports ok when every source matches its recorded checksum', async () => {
    const { manifest, source } = manifestFor({
      'rta-2006': { text: 'the act' },
      'reg-516': { text: 'the regulation' },
    })
    const report = await verifyManifest(manifest, source)

    expect(report.ok).toBe(true)
    expect(report.results).toHaveLength(2)
    expect(report.results.every((r) => r.status === 'ok')).toBe(true)
  })

  it('applies the documented normalization before comparing', async () => {
    const { manifest, source } = manifestFor({
      // Recorded checksum is over the LF-normalized form; source serves CRLF.
      'guideline': { text: 'a\r\nb\r\n', normalization: 'crlf-to-lf' },
    })
    const report = await verifyManifest(manifest, source)
    expect(report.ok).toBe(true)
    expect(report.results[0]?.status).toBe('ok')
  })

  it('flags a checksum mismatch and marks the report not ok', async () => {
    const { manifest } = manifestFor({ 'rta-2006': { text: 'the act' } })
    const tampered: ByteSource = { read: async () => enc('different bytes') }

    const report = await verifyManifest(manifest, tampered)

    expect(report.ok).toBe(false)
    const result = report.results[0]
    expect(result?.status).toBe('mismatch')
    if (result?.status === 'mismatch') {
      expect(result.expected.sha256).not.toBe(result.actual.sha256)
      expect(result.expected.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(result.actual.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('reports a fetch error without throwing, marking the report not ok', async () => {
    const { manifest } = manifestFor({ 'rta-2006': { text: 'the act' } })
    const failing: ByteSource = {
      read: async () => {
        throw new Error('HTTP 503 Service Unavailable')
      },
    }

    const report = await verifyManifest(manifest, failing)

    expect(report.ok).toBe(false)
    const result = report.results[0]
    expect(result?.status).toBe('error')
    if (result?.status === 'error') {
      expect(result.message).toMatch(/503/)
    }
  })

  it('isolates failures: one bad source does not hide the others', async () => {
    const good = manifestFor({ 'good': { text: 'fine' }, 'bad': { text: 'expected' } })
    const mixed: ByteSource = {
      read: async (s) => (s.id === 'bad' ? enc('WRONG') : enc('fine')),
    }

    const report = await verifyManifest(good.manifest, mixed)

    expect(report.ok).toBe(false)
    const byId = Object.fromEntries(report.results.map((r) => [r.source.id, r.status]))
    expect(byId['good']).toBe('ok')
    expect(byId['bad']).toBe('mismatch')
  })

  it('preserves source order in the results', async () => {
    const { manifest, source } = manifestFor({
      'a': { text: '1' },
      'b': { text: '2' },
      'c': { text: '3' },
    })
    const report = await verifyManifest(manifest, source)
    expect(report.results.map((r) => r.source.id)).toEqual(['a', 'b', 'c'])
  })

  it('counts ok and failed sources in the summary', async () => {
    const { manifest } = manifestFor({ 'a': { text: '1' }, 'b': { text: '2' } })
    const mixed: ByteSource = { read: async (s) => (s.id === 'a' ? enc('1') : enc('nope')) }
    const report = await verifyManifest(manifest, mixed)
    expect(report.okCount).toBe(1)
    expect(report.failedCount).toBe(1)
  })
})
