import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  composeDataMountSpecs,
  externalDataRootEnvVar,
  langfuseSharedEnv,
  loadGuardScript,
  loadLangfuseCompose,
  REPO_ROOT_MARKER,
  type ComposeService,
  type LangfuseCompose,
} from './compose-contract.js'

const here = dirname(fileURLToPath(import.meta.url))
const composePath = resolve(here, '../../../infra/langfuse/docker-compose.yml')

const BACKING_STORES = ['postgres', 'clickhouse', 'redis', 'minio'] as const

/** Assert a service exists and return it non-optionally (strict-mode friendly). */
function service(compose: LangfuseCompose, name: string): ComposeService {
  const svc = compose.services[name]
  expect(svc, `missing service: ${name}`).toBeDefined()
  return svc as ComposeService
}

describe('Langfuse compose contract — healthy local UI (AC1)', () => {
  const compose = loadLangfuseCompose(composePath)

  it('defines the Langfuse web service on the v3 image', () => {
    expect(service(compose, 'langfuse-web').image).toMatch(/langfuse\/langfuse:3/)
  })

  it('exposes the web UI on host port 3000', () => {
    const ports = service(compose, 'langfuse-web').ports ?? []
    expect(ports.some((p) => /(^|:)3000:3000$/.test(p))).toBe(true)
  })

  it('runs the async worker alongside the web service', () => {
    expect(service(compose, 'langfuse-worker').image).toMatch(/langfuse-worker:3/)
  })

  it('provisions every backing store the worker depends on', () => {
    for (const dep of BACKING_STORES) {
      expect(service(compose, dep)).toBeDefined()
    }
  })

  it('attaches a healthcheck to every backing store so "compose up" can gate on health', () => {
    for (const dep of BACKING_STORES) {
      const healthcheck = service(compose, dep).healthcheck
      expect(healthcheck, `${dep} has no healthcheck`).toBeDefined()
      expect(healthcheck?.test).toBeTruthy()
    }
  })

  it('makes web and worker wait for the stores to report healthy', () => {
    for (const svc of ['langfuse-web', 'langfuse-worker']) {
      const dependsOn = service(compose, svc).depends_on
      expect(dependsOn, `${svc} has no depends_on`).toBeDefined()
      for (const dep of BACKING_STORES) {
        expect(dependsOn?.[dep]?.condition, `${svc} does not gate on ${dep} health`).toBe(
          'service_healthy',
        )
      }
    }
  })
})

describe('Langfuse compose contract — data volumes outside the synced repo (AC3)', () => {
  it('persists every stateful store via a host-path bind mount, not an in-VM named volume', () => {
    const specs = composeDataMountSpecs(composePath)
    // Every backing store that holds data must bind-mount from the host so the
    // location is explicit and auditable (named volumes hide under the Docker VM).
    const storesWithState = ['postgres', 'clickhouse', 'redis', 'minio']
    for (const store of storesWithState) {
      const mounts = specs.filter((m) => m.service === store)
      expect(mounts.length, `${store} persists nothing`).toBeGreaterThan(0)
      for (const m of mounts) {
        expect(m.type, `${store} mount ${m.target} is not a host bind mount`).toBe('bind')
      }
    }
  })

  it('roots every data bind mount at the external LANGFUSE_DATA_ROOT variable', () => {
    const specs = composeDataMountSpecs(composePath)
    for (const m of specs) {
      expect(
        m.source.includes(`\${${externalDataRootEnvVar}`),
        `mount ${m.service}:${m.target} does not derive from ${externalDataRootEnvVar} (was "${m.source}")`,
      ).toBe(true)
    }
  })

  it('defaults LANGFUSE_DATA_ROOT to a path under the user home, outside the repo', () => {
    const specs = composeDataMountSpecs(composePath)
    const withDefault = specs.find((m) => m.source.includes(':-'))
    expect(withDefault, 'no default provided for LANGFUSE_DATA_ROOT').toBeDefined()
    // Default must be HOME-anchored and must NOT reference the repo working dir.
    expect(withDefault?.source).toMatch(/:-\$\{?HOME/)
    expect(withDefault?.source).not.toContain('${PWD')
    expect(withDefault?.source.toLowerCase()).not.toContain('owners-manual/.claude')
  })

  it('ships a guard service that aborts when the data root resolves inside the repo', () => {
    const guard = service(loadLangfuseCompose(composePath), 'data-root-guard')
    const command = JSON.stringify(guard.command ?? guard.entrypoint ?? '')
    // The guard must reference the repo marker it refuses to write inside of.
    expect(command).toContain(REPO_ROOT_MARKER)
  })
})

/**
 * Drive the data-root guard's actual shell program (same script the busybox
 * container runs) with a candidate data root, returning whether it REFUSED
 * (non-zero exit) and its stderr. Executing the real script — rather than
 * re-implementing the case patterns — keeps the test honest about guard
 * behavior.
 */
function runGuard(dataRoot: string): { refused: boolean; stderr: string } {
  const script = loadGuardScript(composePath)
  try {
    execFileSync('sh', ['-ec', script], {
      env: { ...process.env, RESOLVED_DATA_ROOT: dataRoot },
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    return { refused: false, stderr: '' }
  } catch (error) {
    const err = error as { status?: number; stderr?: string }
    return { refused: (err.status ?? 0) !== 0, stderr: err.stderr ?? '' }
  }
}

describe('Langfuse compose contract — data-root guard refuses unsafe roots (AC3)', () => {
  it('refuses a data root anywhere under an owners-manual directory, even on a non-synced clone', () => {
    // Regression for the gap: a plain `git clone` outside any cloud-sync mount
    // (e.g. ~/repos/owners-manual) must still be refused, because persisting DB
    // files inside the repo working tree is never safe.
    const { refused } = runGuard('/Users/dev/repos/owners-manual/langfuse-data')
    expect(refused, 'data root inside the repo working tree was not refused').toBe(true)
  })

  it('refuses a data root directly inside the repo checkout root', () => {
    const { refused } = runGuard('/home/ci/work/owners-manual/data')
    expect(refused).toBe(true)
  })

  it.each([
    ['/Users/dev/Library/CloudStorage/GoogleDrive-x/My Drive/owners-manual/data', 'My Drive'],
    ['/Users/dev/Library/CloudStorage/GoogleDrive-x/langfuse-data', 'CloudStorage'],
    ['/Users/dev/Dropbox/langfuse-data', 'Dropbox'],
    ['/Users/dev/OneDrive/langfuse-data', 'OneDrive'],
  ])('still refuses the known cloud-sync mount %s', (dataRoot) => {
    expect(runGuard(dataRoot).refused).toBe(true)
  })

  it('refuses an empty data root', () => {
    expect(runGuard('').refused).toBe(true)
  })

  it('accepts a safe external default outside the repo and any cloud-sync folder', () => {
    const { refused } = runGuard('/Users/dev/.owners-manual-data/langfuse')
    expect(refused, 'a safe external data root was wrongly refused').toBe(false)
  })
})

describe('Langfuse compose contract — S3 endpoints reachable from their clients', () => {
  const sharedEnv = langfuseSharedEnv(composePath)

  /** The host port the compose publishes MinIO's S3 API on (the `:9000` target). */
  function minioHostS3Port(): string {
    const ports = service(loadLangfuseCompose(composePath), 'minio').ports ?? []
    const s3 = ports.find((p) => /:9000$/.test(p))
    expect(s3, 'minio does not publish its S3 API (:9000) to the host').toBeDefined()
    const match = /(\d+):9000$/.exec(s3 as string)
    return match?.[1] ?? ''
  }

  it('keeps the event-upload endpoint on the internal compose network (server-to-server)', () => {
    // Event uploads are written by langfuse-web/worker inside the network, so the
    // internal service DNS name is correct and must not change.
    expect(sharedEnv.LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT).toBe('http://minio:9000')
  })

  it('points the media-upload endpoint at a host-reachable URL, not the in-network minio host', () => {
    // Presigned MEDIA upload URLs are handed to clients running on the HOST,
    // where the in-network `minio` hostname does not resolve. The endpoint must
    // therefore be the host-published loopback address.
    const endpoint = sharedEnv.LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT
    expect(endpoint, 'media-upload endpoint is missing').toBeTruthy()
    expect(
      endpoint,
      'media presigned URLs would point at the in-network minio host, unreachable from host clients',
    ).not.toMatch(/\/\/minio[:/]/)
    // Must resolve to the loopback address the compose actually publishes MinIO
    // on. The value may be wrapped in a `${VAR:-default}` override, so match the
    // host-reachable URL anywhere in the string rather than anchoring at start.
    expect(endpoint).toMatch(/http:\/\/(127\.0\.0\.1|localhost):\d+/)
    expect(endpoint).toContain(`:${minioHostS3Port()}`)
  })
})

describe('Langfuse compose contract — LANGFUSE_HOST env contract (AC4)', () => {
  const here2 = dirname(fileURLToPath(import.meta.url))
  // The root .env.example is the canonical env contract (issue #6 absorbed the
  // former infra/langfuse/.env.example into it).
  const envExamplePath = resolve(here2, '../../../.env.example')

  it('declares LANGFUSE_HOST with the local self-host default', async () => {
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(envExamplePath, 'utf8')
    expect(text).toMatch(/^LANGFUSE_HOST=http:\/\/localhost:3000\s*$/m)
  })

  it('documents the Langfuse Cloud fallback host as a commented alternative', async () => {
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(envExamplePath, 'utf8')
    expect(text).toMatch(/cloud\.langfuse\.com/)
  })

  it('declares placeholder public and secret keys without committing real secrets', async () => {
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(envExamplePath, 'utf8')
    expect(text).toMatch(/^LANGFUSE_PUBLIC_KEY=pk-lf-PLACEHOLDER/m)
    expect(text).toMatch(/^LANGFUSE_SECRET_KEY=sk-lf-PLACEHOLDER/m)
    // Reject a real-looking key: genuine Langfuse keys carry a long lowercase
    // hex/base-ish suffix. A placeholder must never look like that.
    expect(text).not.toMatch(/sk-lf-[0-9a-f]{16,}/)
  })
})
