import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { diskByteSource, loadManifest, writeSource } from './storage.js'
import type { ManifestSource } from './manifest/schema.js'

const enc = (s: string) => new TextEncoder().encode(s)

function source(overrides: Partial<ManifestSource> = {}): ManifestSource {
  return {
    id: 'rta-2006',
    title: 'RTA',
    url: 'https://example.test/rta',
    file: 'tenancy/rta-2006.html',
    sha256: 'a'.repeat(64),
    bytes: 3,
    consolidationDate: '2024-01-01',
    licence: { holder: "King's Printer for Ontario", note: 'n' },
    normalization: 'none',
    ...overrides,
  }
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'corpus-storage-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('loadManifest', () => {
  it('reads and validates a manifest JSON file', async () => {
    const path = join(dir, 'manifest.json')
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        generatedAt: '2026-06-09T00:00:00.000Z',
        sources: [source()],
      }),
    )
    const manifest = await loadManifest(path)
    expect(manifest.sources[0]?.id).toBe('rta-2006')
  })

  it('throws a clear error when the file is missing', async () => {
    await expect(loadManifest(join(dir, 'nope.json'))).rejects.toThrow(/manifest/i)
  })

  it('throws a validation error for malformed manifest JSON content', async () => {
    const path = join(dir, 'bad.json')
    await writeFile(path, JSON.stringify({ version: 1, generatedAt: 'x', sources: [] }))
    await expect(loadManifest(path)).rejects.toThrow(/at least one/i)
  })

  it('throws on non-JSON content', async () => {
    const path = join(dir, 'notjson.json')
    await writeFile(path, 'this is not json {')
    await expect(loadManifest(path)).rejects.toThrow()
  })
})

describe('writeSource + diskByteSource round trip', () => {
  it('writes bytes under rawRoot/file and reads them back identically', async () => {
    const s = source({ file: 'tenancy/rta-2006.html' })
    const bytes = enc('the act')

    await writeSource(dir, s, bytes)
    const readBack = await diskByteSource(dir).read(s)

    expect(Buffer.from(readBack).equals(Buffer.from(bytes))).toBe(true)
  })

  it('creates nested directories as needed', async () => {
    const s = source({ file: 'a/b/c/deep.txt' })
    await writeSource(dir, s, enc('deep'))
    const onDisk = await readFile(join(dir, 'a/b/c/deep.txt'))
    expect(onDisk.toString()).toBe('deep')
  })

  it('diskByteSource read rejects with a clear error when the file is absent', async () => {
    const s = source({ file: 'missing/file.html' })
    await expect(diskByteSource(dir).read(s)).rejects.toThrow(/missing\/file\.html|not been fetched/i)
  })

  it('rejects a file path that escapes rawRoot', async () => {
    const escaping = source({ file: '../escape.txt' })
    await expect(writeSource(dir, escaping, enc('x'))).rejects.toThrow(/outside|escape|invalid/i)
  })
})
