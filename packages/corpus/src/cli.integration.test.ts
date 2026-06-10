import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { run } from './cli.js'
import type { CliDeps } from './cli.js'
import type { ByteSource } from './verify.js'

/**
 * End-to-end CLI test over the COMMITTED fixtures
 * (src/__fixtures__/manifest.json + src/__fixtures__/raw/). This is the
 * network-free proof that runs in CI: verify-only re-derives every fixture's
 * checksum from disk and matches, exactly the "reproduces identical bytes on a
 * clean checkout" criterion, without redistributing Crown copyright text.
 */

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE_MANIFEST = join(here, '__fixtures__', 'manifest.json')
const FIXTURE_RAW = join(here, '__fixtures__', 'raw')

/** A byte source that fails loudly: verify-only must never touch the network. */
const explodingNetwork: () => ByteSource = () => ({
  read: async () => {
    throw new Error('verify-only must not reach the network')
  },
})

function capture() {
  const sink = { out: '', err: '' }
  const deps: CliDeps = {
    stdout: (s) => {
      sink.out += s
    },
    stderr: (s) => {
      sink.err += s
    },
    networkSource: explodingNetwork,
  }
  return { sink, deps }
}

describe('CLI over committed fixtures (verify-only, no network)', () => {
  it('verifies every committed fixture against the committed manifest', async () => {
    const { sink, deps } = capture()
    const code = await run(
      ['--manifest', FIXTURE_MANIFEST, '--raw', FIXTURE_RAW, '--verify-only'],
      deps,
    )

    expect(code).toBe(0)
    expect(sink.out).toMatch(/OK/)
    expect(sink.out).toMatch(/clean-doc/)
    expect(sink.out).toMatch(/waf-doc/)
    expect(sink.err).toBe('')
  })

  it('detects tampering: a mutated copy of a fixture fails verification', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'corpus-fixture-tamper-'))
    try {
      await cp(FIXTURE_RAW, dir, { recursive: true })
      await writeFile(join(dir, 'clean-doc.html'), 'tampered bytes')

      const { sink, deps } = capture()
      const code = await run(
        ['--manifest', FIXTURE_MANIFEST, '--raw', dir, '--verify-only'],
        deps,
      )

      expect(code).toBe(1)
      expect(sink.err).toMatch(/MISMATCH/)
      expect(sink.err).toMatch(/clean-doc/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

let nullDir: string
beforeEach(async () => {
  nullDir = await mkdtemp(join(tmpdir(), 'corpus-null-'))
})
afterEach(async () => {
  await rm(nullDir, { recursive: true, force: true })
})

describe('CLI rebuild over a fixture byte source (no real network)', () => {
  it('rebuilds the fixtures into a fresh dir and they re-verify identically', async () => {
    // A byte source that serves the committed fixture bytes by id, standing in
    // for the network so the rebuild path is covered without a request.
    const { readFile } = await import('node:fs/promises')
    const served: Record<string, string> = {
      'clean-doc': join(FIXTURE_RAW, 'clean-doc.html'),
      'waf-doc': join(FIXTURE_RAW, 'waf-doc.html'),
    }
    const networkSource: () => ByteSource = () => ({
      read: async (s) => {
        const path = served[s.id]
        if (!path) throw new Error(`no fixture for ${s.id}`)
        return new Uint8Array(await readFile(path))
      },
    })

    const sink = { out: '', err: '' }
    const deps: CliDeps = {
      stdout: (s) => {
        sink.out += s
      },
      stderr: (s) => {
        sink.err += s
      },
      networkSource,
    }

    const fetchCode = await run(['--manifest', FIXTURE_MANIFEST, '--raw', nullDir], deps)
    expect(fetchCode).toBe(0)
    expect(sink.out).toMatch(/OK/)

    // verify-only the freshly rebuilt dir — proves stored bytes match the manifest.
    const verifyCode = await run(
      ['--manifest', FIXTURE_MANIFEST, '--raw', nullDir, '--verify-only'],
      { ...deps, networkSource: explodingNetwork },
    )
    expect(verifyCode).toBe(0)
  })
})
