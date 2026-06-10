import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildCurlArgs, curlByteSource, spawnCurl } from './curl.js'
import type { CurlRunner } from './curl.js'
import type { ManifestSource } from './manifest/schema.js'

const enc = (s: string) => new TextEncoder().encode(s)

function source(overrides: Partial<ManifestSource> = {}): ManifestSource {
  return {
    id: 'rta-2006',
    title: 'RTA',
    url: 'https://www.ontario.ca/laws/statute/06r17',
    file: 'tenancy/rta-2006.html',
    sha256: 'a'.repeat(64),
    bytes: 3,
    consolidationDate: '2024-01-01',
    licence: { holder: "King's Printer for Ontario", note: 'n' },
    normalization: 'strip-waf',
    ...overrides,
  }
}

describe('buildCurlArgs', () => {
  it('fails on HTTP errors, follows redirects, and is silent', () => {
    const args = buildCurlArgs('https://example.test/x')
    expect(args).toContain('--fail')
    expect(args).toContain('--location')
    expect(args).toContain('--silent')
    expect(args).toContain('--show-error')
  })

  it('passes the URL after a "--" end-of-options guard', () => {
    const args = buildCurlArgs('https://example.test/x')
    const sep = args.indexOf('--')
    expect(sep).toBeGreaterThanOrEqual(0)
    expect(args[sep + 1]).toBe('https://example.test/x')
    expect(args[args.length - 1]).toBe('https://example.test/x')
  })
})

describe('curlByteSource', () => {
  it('runs curl with the source URL and returns the stdout bytes', async () => {
    const body = enc('<html>the act</html>')
    const runner: CurlRunner = vi.fn(async () => ({ status: 0, stdout: body, stderr: new Uint8Array(0) }))

    const bytes = await curlByteSource(runner).read(source())

    expect(runner).toHaveBeenCalledTimes(1)
    expect(Buffer.from(bytes).equals(Buffer.from(body))).toBe(true)
  })

  it('passes the source URL through to the runner args', async () => {
    let capturedArgs: readonly string[] = []
    const runner: CurlRunner = async (args) => {
      capturedArgs = args
      return { status: 0, stdout: enc('ok'), stderr: new Uint8Array(0) }
    }
    await curlByteSource(runner).read(source({ url: 'https://example.test/abc' }))
    expect(capturedArgs).toContain('https://example.test/abc')
  })

  it('throws with the exit code and stderr on a nonzero curl exit', async () => {
    const runner: CurlRunner = async () => ({
      status: 22,
      stdout: new Uint8Array(0),
      stderr: enc('curl: (22) The requested URL returned error: 404'),
    })
    await expect(curlByteSource(runner).read(source())).rejects.toThrow(/22|404/)
  })

  it('throws when the runner itself rejects (curl not found)', async () => {
    const runner: CurlRunner = async () => {
      throw new Error('spawn curl ENOENT')
    }
    await expect(curlByteSource(runner).read(source())).rejects.toThrow(/ENOENT|curl/)
  })
})

// Exercises the real spawnCurl against a file:// URL — no network, so it is
// CI-safe while still covering the process-spawn wiring (stdout capture, exit
// code, and the nonzero-exit failure path).
describe('spawnCurl (real process, local file:// only)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'corpus-curl-real-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads a local file and returns its bytes with exit 0', async () => {
    const path = join(dir, 'doc.html')
    await writeFile(path, 'local body bytes')
    const url = pathToFileURL(path).href

    const result = await spawnCurl(buildCurlArgs(url))

    expect(result.status).toBe(0)
    expect(new TextDecoder().decode(result.stdout)).toBe('local body bytes')
  })

  it('curlByteSource returns the local file bytes end to end', async () => {
    const path = join(dir, 'doc.html')
    await writeFile(path, 'end to end body')
    const url = pathToFileURL(path).href

    const bytes = await curlByteSource().read({ ...source(), url })
    expect(new TextDecoder().decode(bytes)).toBe('end to end body')
  })

  it('reports a nonzero exit for a missing local file', async () => {
    const url = pathToFileURL(join(dir, 'does-not-exist.html')).href
    const result = await spawnCurl(buildCurlArgs(url))
    expect(result.status).not.toBe(0)
  })
})
