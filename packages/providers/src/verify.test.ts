import { describe, expect, it } from 'vitest'

import {
  formatResultsTable,
  PROVIDER_CHECK_IDS,
  runVerification,
  verificationExitCode,
  type ProviderProbes,
  type VerifyEnv,
} from './verify.js'

/** Probes where every provider answers successfully. */
function passingProbes(overrides: Partial<ProviderProbes> = {}): ProviderProbes {
  return {
    atlasPing: async () => 'connected; ping ok',
    geminiGenerate: async () => 'gemini-2.5-flash replied',
    geminiEmbed: async () => '3072-dim vector',
    voyageEmbed: async () => '1024-dim vector',
    cohereRerank: async () => 'reranked 2 documents',
    langfuseHealth: async () => 'OK v3.x',
    ...overrides,
  }
}

/** A fully-populated env with realistic-looking (fake) secrets. */
function fullEnv(overrides: VerifyEnv = {}): VerifyEnv {
  return {
    MONGODB_URI: 'mongodb+srv://owner:hunter2pass@cluster0.fake.mongodb.net/?retryWrites=true',
    MONGODB_DB: 'owners_manual',
    GOOGLE_CLOUD_PROJECT: 'owners-manual-fake',
    GOOGLE_CLOUD_LOCATION: 'global',
    VOYAGE_API_KEY: 'pa-fake-voyage-key',
    COHERE_API_KEY: 'fake-cohere-key',
    LANGFUSE_HOST: 'http://localhost:3000',
    ...overrides,
  }
}

describe('runVerification', () => {
  it('passes every check when all probes succeed', async () => {
    const results = await runVerification(fullEnv(), passingProbes())

    expect(results.map((r) => r.id)).toEqual([...PROVIDER_CHECK_IDS])
    expect(results.map((r) => r.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass'])
    expect(verificationExitCode(results)).toBe(0)
  })

  it('fails a required check when its env var is missing, naming the var', async () => {
    const env = fullEnv({ MONGODB_URI: undefined })
    const results = await runVerification(env, passingProbes())

    const atlas = results.find((r) => r.id === 'atlas')
    expect(atlas?.status).toBe('fail')
    expect(atlas?.detail).toContain('MONGODB_URI')
    expect(verificationExitCode(results)).toBe(1)
  })

  it('treats PLACEHOLDER / CHANGEME values as unset', async () => {
    const env = fullEnv({ VOYAGE_API_KEY: 'pa-PLACEHOLDER-REPLACE-ME' })
    const results = await runVerification(env, passingProbes())

    const voyage = results.find((r) => r.id === 'voyage')
    expect(voyage?.status).toBe('fail')
    expect(voyage?.detail).toContain('VOYAGE_API_KEY')
  })

  it('marks a required check failed when its probe throws', async () => {
    const probes = passingProbes({
      cohereRerank: async () => {
        throw new Error('401 invalid api token')
      },
    })
    const results = await runVerification(fullEnv(), probes)

    const cohere = results.find((r) => r.id === 'cohere')
    expect(cohere?.status).toBe('fail')
    expect(cohere?.detail).toContain('401')
    expect(verificationExitCode(results)).toBe(1)
  })

  it('flattens multi-line (JSON-shaped) error messages instead of truncating to the first line', async () => {
    const probes = passingProbes({
      geminiGenerate: async () => {
        throw new Error(
          '{\n  "error": {\n    "code": 403,\n    "status": "PERMISSION_DENIED"\n  }\n}',
        )
      },
    })
    const results = await runVerification(fullEnv(), probes)

    const gemini = results.find((r) => r.id === 'vertex-gemini')
    expect(gemini?.status).toBe('fail')
    expect(gemini?.detail).toContain('PERMISSION_DENIED')
    expect(gemini?.detail).not.toBe('{')
  })

  it('never leaks secret env values into failure details', async () => {
    const probes = passingProbes({
      atlasPing: async () => {
        throw new Error(
          'connect failed for mongodb+srv://owner:hunter2pass@cluster0.fake.mongodb.net/?retryWrites=true',
        )
      },
    })
    const results = await runVerification(fullEnv(), probes)
    const rendered = formatResultsTable(results)

    expect(rendered).not.toContain('hunter2pass')
    expect(rendered).not.toContain('pa-fake-voyage-key')
    expect(rendered).toContain('[redacted]')
  })

  it('reports the vertex embedding probe as warn (not fail) and keeps exit 0', async () => {
    const probes = passingProbes({
      geminiEmbed: async () => {
        throw new Error('embedding model not available on global endpoint')
      },
    })
    const results = await runVerification(fullEnv(), probes)

    const embed = results.find((r) => r.id === 'vertex-embedding')
    expect(embed?.status).toBe('warn')
    expect(embed?.required).toBe(false)
    expect(verificationExitCode(results)).toBe(0)
  })

  it('skips the embedding probe when the vertex env is missing entirely', async () => {
    const env = fullEnv({ GOOGLE_CLOUD_PROJECT: undefined })
    const results = await runVerification(env, passingProbes())

    expect(results.find((r) => r.id === 'vertex-gemini')?.status).toBe('fail')
    expect(results.find((r) => r.id === 'vertex-embedding')?.status).toBe('skip')
  })

  it('defaults LANGFUSE_HOST and GOOGLE_CLOUD_LOCATION when unset', async () => {
    const seen: string[] = []
    const probes = passingProbes({
      langfuseHealth: async (host) => {
        seen.push(host)
        return 'OK'
      },
      geminiGenerate: async (_project, location) => {
        seen.push(location)
        return 'ok'
      },
    })
    const env = fullEnv({ LANGFUSE_HOST: undefined, GOOGLE_CLOUD_LOCATION: undefined })
    await runVerification(env, probes)

    expect(seen).toContain('http://localhost:3000')
    expect(seen).toContain('global')
  })
})

describe('formatResultsTable', () => {
  it('renders one aligned row per check plus a summary line', async () => {
    const results = await runVerification(fullEnv(), passingProbes())
    const rendered = formatResultsTable(results)
    const lines = rendered.trimEnd().split('\n')

    for (const id of PROVIDER_CHECK_IDS) {
      expect(rendered).toContain(id)
    }
    expect(lines.at(-1)).toMatch(/6 pass/)
    expect(rendered).toContain('PASS')
  })

  it('summarizes failures and warns distinctly', async () => {
    const probes = passingProbes({
      voyageEmbed: async () => {
        throw new Error('429 too many requests')
      },
      geminiEmbed: async () => {
        throw new Error('not on global')
      },
    })
    const rendered = formatResultsTable(await runVerification(fullEnv(), probes))

    expect(rendered).toContain('FAIL')
    expect(rendered).toContain('WARN')
    expect(rendered).toMatch(/1 fail/)
    expect(rendered).toMatch(/1 warn/)
  })
})
