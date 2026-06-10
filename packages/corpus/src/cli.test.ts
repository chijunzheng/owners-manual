import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checksum } from './hash.js'
import { run } from './cli.js'
import type { CliDeps } from './cli.js'
import type { ByteSource } from './verify.js'
import type { ManifestSource } from './manifest/schema.js'

const enc = (s: string) => new TextEncoder().encode(s)

function manifestJson(content: Record<string, string>): string {
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
  return JSON.stringify({ version: 1, generatedAt: '2026-06-09T00:00:00.000Z', sources })
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

interface Captured {
  out: string
  err: string
  deps: CliDeps
}

function capturing(networkSource: ByteSource): Captured {
  const captured: Captured = {
    out: '',
    err: '',
    deps: {
      stdout: (s) => {
        captured.out += s
      },
      stderr: (s) => {
        captured.err += s
      },
      networkSource: () => networkSource,
    },
  }
  return captured
}

let dir: string
let manifestPath: string
let rawRoot: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'corpus-cli-'))
  manifestPath = join(dir, 'manifest.json')
  rawRoot = join(dir, 'raw')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('run (fetch mode)', () => {
  it('returns exit code 0 and a verified report when all sources match', async () => {
    await writeFile(manifestPath, manifestJson({ 'rta-2006': 'the act' }))
    const cap = capturing(fixedSource({ 'rta-2006': 'the act' }))

    const code = await run(['--manifest', manifestPath, '--raw', rawRoot], cap.deps)

    expect(code).toBe(0)
    expect(cap.out).toMatch(/OK/)
    expect(cap.out).toMatch(/rta-2006/)
  })

  it('returns exit code 1 and a FAIL report on a checksum mismatch', async () => {
    await writeFile(manifestPath, manifestJson({ 'rta-2006': 'the act' }))
    const cap = capturing(fixedSource({ 'rta-2006': 'CORRUPTED' }))

    const code = await run(['--manifest', manifestPath, '--raw', rawRoot], cap.deps)

    expect(code).toBe(1)
    expect(cap.err).toMatch(/FAIL/)
    expect(cap.err).toMatch(/MISMATCH/)
  })

  it('returns a nonzero code and reports the error when the manifest is missing', async () => {
    const cap = capturing(fixedSource({}))
    const code = await run(['--manifest', join(dir, 'nope.json'), '--raw', rawRoot], cap.deps)
    expect(code).toBe(1)
    expect(cap.err).toMatch(/manifest/i)
  })
})

describe('run (verify-only mode)', () => {
  it('verifies from disk without the network source and passes after a fetch', async () => {
    await writeFile(manifestPath, manifestJson({ 'rta-2006': 'the act' }))

    // First, a fetch run populates the raw dir.
    const fetchCap = capturing(fixedSource({ 'rta-2006': 'the act' }))
    expect(await run(['--manifest', manifestPath, '--raw', rawRoot], fetchCap.deps)).toBe(0)

    // Then verify-only must pass using a network source that would THROW if used.
    const exploding: ByteSource = {
      read: async () => {
        throw new Error('network must not be touched in verify-only mode')
      },
    }
    const verifyCap = capturing(exploding)
    const code = await run(
      ['--manifest', manifestPath, '--raw', rawRoot, '--verify-only'],
      verifyCap.deps,
    )

    expect(code).toBe(0)
    expect(verifyCap.out).toMatch(/OK/)
  })

  it('fails verify-only when the raw bytes are absent', async () => {
    await writeFile(manifestPath, manifestJson({ 'rta-2006': 'the act' }))
    const cap = capturing(fixedSource({}))

    const code = await run(
      ['--manifest', manifestPath, '--raw', rawRoot, '--verify-only'],
      cap.deps,
    )

    expect(code).toBe(1)
    expect(cap.err).toMatch(/not been fetched|FAIL/)
  })
})
