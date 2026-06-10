import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  composeDataMountSpecs,
  externalDataRootEnvVar,
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

describe('Langfuse compose contract — LANGFUSE_HOST env contract (AC4)', () => {
  const here2 = dirname(fileURLToPath(import.meta.url))
  const envExamplePath = resolve(here2, '../../../infra/langfuse/.env.example')

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
