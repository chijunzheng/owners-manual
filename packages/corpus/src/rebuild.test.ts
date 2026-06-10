import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checksum } from './hash.js'
import { normalizeBytes } from './normalize.js'
import { rebuild } from './rebuild.js'
import { diskByteSource } from './storage.js'
import type { ByteSource } from './verify.js'
import type { Manifest, ManifestSource } from './manifest/schema.js'

const enc = (s: string) => new TextEncoder().encode(s)

function manifestFor(content: Record<string, string>): Manifest {
  const sources: ManifestSource[] = Object.entries(content).map(([id, text]) => {
    const { sha256, bytes } = checksum(enc(text), 'none')
    return {
      id,
      title: `Title ${id}`,
      url: `https://example.test/${id}`,
      file: `${id}.txt`,
      sha256,
      bytes,
      consolidationDate: '2024-01-01',
      licence: { holder: "King's Printer for Ontario", note: 'n' },
      normalization: 'none',
    }
  })
  return { version: 1, generatedAt: '2026-06-09T00:00:00.000Z', sources }
}

function fixedSource(content: Record<string, string>): ByteSource {
  const map = new Map(Object.entries(content).map(([id, text]) => [id, enc(text)]))
  return {
    read: async (s) => {
      const found = map.get(s.id)
      if (!found) throw new Error(`no bytes for ${s.id}`)
      return found
    },
  }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'corpus-rebuild-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('rebuild', () => {
  it('writes every source to disk when all checksums match', async () => {
    const manifest = manifestFor({ 'rta-2006': 'the act', 'reg-516': 'the reg' })
    const report = await rebuild(manifest, fixedSource({ 'rta-2006': 'the act', 'reg-516': 'the reg' }), dir)

    expect(report.ok).toBe(true)
    expect((await readFile(join(dir, 'rta-2006.txt'))).toString()).toBe('the act')
    expect((await readFile(join(dir, 'reg-516.txt'))).toString()).toBe('the reg')
  })

  it('produces bytes that re-verify clean from disk (byte-identical rebuild)', async () => {
    const manifest = manifestFor({ 'rta-2006': 'the act' })
    await rebuild(manifest, fixedSource({ 'rta-2006': 'the act' }), dir)

    // Second pass reads only from disk — no network — and must verify.
    const { verifyManifest } = await import('./verify.js')
    const second = await verifyManifest(manifest, diskByteSource(dir))
    expect(second.ok).toBe(true)
  })

  it('does not write a source whose checksum mismatches', async () => {
    const manifest = manifestFor({ 'rta-2006': 'the act' })
    const report = await rebuild(manifest, fixedSource({ 'rta-2006': 'CORRUPTED' }), dir)

    expect(report.ok).toBe(false)
    expect(report.results[0]?.status).toBe('mismatch')
    await expect(readFile(join(dir, 'rta-2006.txt'))).rejects.toThrow()
  })

  it('writes the good sources even when a sibling fails', async () => {
    const manifest = manifestFor({ 'good': 'fine', 'bad': 'expected' })
    const report = await rebuild(manifest, fixedSource({ 'good': 'fine', 'bad': 'WRONG' }), dir)

    expect(report.ok).toBe(false)
    expect((await readFile(join(dir, 'good.txt'))).toString()).toBe('fine')
    await expect(readFile(join(dir, 'bad.txt'))).rejects.toThrow()
  })

  it('does not write a source that errors during fetch', async () => {
    const manifest = manifestFor({ 'rta-2006': 'the act' })
    const failing: ByteSource = {
      read: async () => {
        throw new Error('HTTP 500')
      },
    }
    const report = await rebuild(manifest, failing, dir)
    expect(report.ok).toBe(false)
    expect(report.results[0]?.status).toBe('error')
    await expect(readFile(join(dir, 'rta-2006.txt'))).rejects.toThrow()
  })

  describe('writes the normalized form (so stored bytes are reproducible)', () => {
    function wafManifest(): Manifest {
      const stable = '<head>\n<title>act</title>\n</head>'
      const { sha256, bytes } = checksum(enc(stable), 'strip-waf')
      return {
        version: 1,
        generatedAt: '2026-06-09T00:00:00.000Z',
        sources: [
          {
            id: 'doc',
            title: 'Doc',
            url: 'https://example.test/doc',
            file: 'doc.html',
            sha256,
            bytes,
            consolidationDate: '2024-01-01',
            licence: { holder: "King's Printer for Ontario", note: 'n' },
            normalization: 'strip-waf',
          },
        ],
      }
    }

    it('stores the WAF-stripped bytes, not the raw response', async () => {
      const rawWithWaf = '<head>\n<script>var __uzdbm_1 = "RANDOM";</script>\n<title>act</title>\n</head>'
      const report = await rebuild(wafManifest(), { read: async () => enc(rawWithWaf) }, dir)

      expect(report.ok).toBe(true)
      const onDisk = new Uint8Array(await readFile(join(dir, 'doc.html')))
      const expected = normalizeBytes(enc(rawWithWaf), 'strip-waf')
      expect(Buffer.from(onDisk).equals(Buffer.from(expected))).toBe(true)
      expect(new TextDecoder().decode(onDisk)).not.toContain('__uzdbm')
    })

    it('two fetches differing only in WAF tokens write byte-identical files', async () => {
      const fetchA = '<head>\n<script>var __uzdbm_1 = "AAA";</script>\n<title>act</title>\n</head>'
      const fetchB = '<head>\n<script>var __uzdbm_1 = "ZZZ";</script>\n<title>act</title>\n</head>'

      const dirA = await mkdtemp(join(tmpdir(), 'rebuild-a-'))
      const dirB = await mkdtemp(join(tmpdir(), 'rebuild-b-'))
      try {
        await rebuild(wafManifest(), { read: async () => enc(fetchA) }, dirA)
        await rebuild(wafManifest(), { read: async () => enc(fetchB) }, dirB)
        const a = new Uint8Array(await readFile(join(dirA, 'doc.html')))
        const b = new Uint8Array(await readFile(join(dirB, 'doc.html')))
        expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
      } finally {
        await rm(dirA, { recursive: true, force: true })
        await rm(dirB, { recursive: true, force: true })
      }
    })

    it('the stored bytes re-verify clean (normalization is idempotent on disk)', async () => {
      const rawWithWaf = '<head>\n<script>var __uzdbm_1 = "X";</script>\n<title>act</title>\n</head>'
      await rebuild(wafManifest(), { read: async () => enc(rawWithWaf) }, dir)

      const { verifyManifest } = await import('./verify.js')
      const verified = await verifyManifest(wafManifest(), diskByteSource(dir))
      expect(verified.ok).toBe(true)
    })
  })
})
