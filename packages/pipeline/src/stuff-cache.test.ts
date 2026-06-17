import { describe, expect, it, vi } from 'vitest'

import { type CorpusChunk } from './chunk-corpus.js'
import {
  STUFF_CACHE_TTL_SECONDS,
  buildCachePrefix,
  cacheDisplayName,
  decideCacheAction,
  provisionStuffCache,
  resolveStuffCachedContentName,
  type CachedContentProvisioner,
  type StuffCacheRecord,
} from './stuff-cache.js'
import { buildStuffedCandidates } from './stuff-synthesis.js'
import { buildSynthesisPrompt } from './synthesize.js'

// The stuffing-arm context-cache lifecycle (#44). The DECISION logic (reuse vs
// recreate, keyed to the corpus build hash + model + TTL), the canonical-prefix
// assembly the cache covers, and the provisioning orchestration over an injected
// seam are all PURE and unit-tested here against a fake provisioner — never a
// live Vertex `CachedContent` create call. The live binding (the real Vertex
// cache REST/SDK surface, which `@langchain/google-vertexai` does not expose) and
// AC3/AC4 (live `cache_read` + end-to-end) are deferred to the live-run milestone.

const tenancy: CorpusChunk = {
  id: 'rta#0',
  citablePathKey: 'rta-2006|section:20',
  text: 'A landlord is responsible for repairs.',
  documentId: 'rta-2006',
  chunker: 'hierarchy-v1',
}
const governing: CorpusChunk = {
  id: 'decl#0',
  citablePathKey: 'fixture-declaration|section:pets',
  text: 'No pets over 25kg.',
  documentId: 'fixture-declaration',
  chunker: 'hierarchy-v1',
}
const corpus: readonly CorpusChunk[] = [tenancy, governing]

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)
const MODEL = 'gemini-2.5-pro'
const NOW = 1_000_000

function recordFor(overrides: Partial<StuffCacheRecord> = {}): StuffCacheRecord {
  return {
    name: 'projects/p/locations/global/cachedContents/abc',
    corpusBuildHash: HASH_A,
    model: MODEL,
    expiresAtMs: NOW + STUFF_CACHE_TTL_SECONDS * 1000,
    ...overrides,
  }
}

/** A fake provisioner that records its create calls; never touches Vertex. */
function fakeProvisioner(name = 'projects/p/locations/global/cachedContents/new'): {
  readonly provisioner: CachedContentProvisioner
  readonly create: ReturnType<typeof vi.fn>
} {
  const create = vi.fn(async () => ({ name }))
  return { provisioner: { create }, create }
}

describe('buildCachePrefix — the canonical corpus prefix the cache covers', () => {
  it('renders the full corpus in fixed canonical order (the stuff-arm prefix)', () => {
    const prefix = buildCachePrefix(corpus)
    // The two chunks appear in canonical order, with their text, addressable.
    expect(prefix.indexOf('rta-2006')).toBeLessThan(prefix.indexOf('fixture-declaration'))
    expect(prefix).toContain('A landlord is responsible for repairs.')
    expect(prefix).toContain('No pets over 25kg.')
  })

  it('is deterministic — the same chunks in the same order yield the same string', () => {
    expect(buildCachePrefix(corpus)).toBe(buildCachePrefix([tenancy, governing]))
  })

  it('changes when the corpus order changes (the cache key depends on the prefix)', () => {
    expect(buildCachePrefix(corpus)).not.toBe(buildCachePrefix([governing, tenancy]))
  })

  it('throws on an empty corpus rather than caching nothing (a build bug)', () => {
    expect(() => buildCachePrefix([])).toThrow()
  })
})

describe('cacheDisplayName — keys the cache to the build hash + model', () => {
  it('embeds the corpus build hash so a stale cache is identifiable', () => {
    expect(cacheDisplayName(HASH_A, MODEL)).toContain(HASH_A)
  })

  it('differs across builds and across models', () => {
    expect(cacheDisplayName(HASH_A, MODEL)).not.toBe(cacheDisplayName(HASH_B, MODEL))
    expect(cacheDisplayName(HASH_A, MODEL)).not.toBe(cacheDisplayName(HASH_A, 'gemini-2.5-flash'))
  })
})

describe('STUFF_CACHE_TTL_SECONDS — a sane, documented TTL', () => {
  it('is a positive, finite number of seconds', () => {
    expect(STUFF_CACHE_TTL_SECONDS).toBeGreaterThan(0)
    expect(Number.isFinite(STUFF_CACHE_TTL_SECONDS)).toBe(true)
  })
})

describe('decideCacheAction — reuse vs recreate keyed to build hash + model + TTL', () => {
  it('recreates when there is no existing record', () => {
    expect(
      decideCacheAction({ existing: undefined, corpusBuildHash: HASH_A, model: MODEL, nowMs: NOW }),
    ).toBe('recreate')
  })

  it('reuses a record matching the build hash + model and not expired', () => {
    expect(
      decideCacheAction({
        existing: recordFor(),
        corpusBuildHash: HASH_A,
        model: MODEL,
        nowMs: NOW,
      }),
    ).toBe('reuse')
  })

  it('recreates when the corpus build hash changed', () => {
    expect(
      decideCacheAction({
        existing: recordFor({ corpusBuildHash: HASH_A }),
        corpusBuildHash: HASH_B,
        model: MODEL,
        nowMs: NOW,
      }),
    ).toBe('recreate')
  })

  it('recreates when the model changed', () => {
    expect(
      decideCacheAction({
        existing: recordFor({ model: 'gemini-2.5-flash' }),
        corpusBuildHash: HASH_A,
        model: MODEL,
        nowMs: NOW,
      }),
    ).toBe('recreate')
  })

  it('recreates when the cache has expired (TTL elapsed)', () => {
    const expired = recordFor({ expiresAtMs: NOW - 1 })
    expect(
      decideCacheAction({ existing: expired, corpusBuildHash: HASH_A, model: MODEL, nowMs: NOW }),
    ).toBe('recreate')
  })

  it('treats the exact expiry instant as expired (recreate at the boundary)', () => {
    const atBoundary = recordFor({ expiresAtMs: NOW })
    expect(
      decideCacheAction({
        existing: atBoundary,
        corpusBuildHash: HASH_A,
        model: MODEL,
        nowMs: NOW,
      }),
    ).toBe('recreate')
  })

  // Codex PR #59: context caches are region-scoped and their resource name is
  // location-scoped, so a location change must recreate — else a client in the new
  // region references a cache that lives in another region.
  it('recreates when the Vertex location changed', () => {
    expect(
      decideCacheAction({
        existing: recordFor({ location: 'us-central1' }),
        corpusBuildHash: HASH_A,
        model: MODEL,
        location: 'us-east1',
        nowMs: NOW,
      }),
    ).toBe('recreate')
  })

  it('reuses when the Vertex location is unchanged', () => {
    expect(
      decideCacheAction({
        existing: recordFor({ location: 'us-central1' }),
        corpusBuildHash: HASH_A,
        model: MODEL,
        location: 'us-central1',
        nowMs: NOW,
      }),
    ).toBe('reuse')
  })

  it('recreates when a location is now pinned but the cached record had none', () => {
    expect(
      decideCacheAction({
        existing: recordFor(), // no location persisted
        corpusBuildHash: HASH_A,
        model: MODEL,
        location: 'us-central1',
        nowMs: NOW,
      }),
    ).toBe('recreate')
  })
})

describe('provisionStuffCache — orchestrates decide → create/reuse over the seam', () => {
  it('creates a CachedContent on a fresh build and returns its resource name + record', async () => {
    const { provisioner, create } = fakeProvisioner('projects/p/locations/global/cachedContents/x')
    const result = await provisionStuffCache({
      provisioner,
      chunks: corpus,
      corpusBuildHash: HASH_A,
      model: MODEL,
      nowMs: NOW,
      existing: undefined,
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(result.cachedContentName).toBe('projects/p/locations/global/cachedContents/x')
    expect(result.record).toEqual({
      name: 'projects/p/locations/global/cachedContents/x',
      corpusBuildHash: HASH_A,
      model: MODEL,
      expiresAtMs: NOW + STUFF_CACHE_TTL_SECONDS * 1000,
    })
  })

  it('threads the display name, the canonical prefix, model, location, and TTL into create', async () => {
    const { provisioner, create } = fakeProvisioner()
    await provisionStuffCache({
      provisioner,
      chunks: corpus,
      corpusBuildHash: HASH_A,
      model: MODEL,
      location: 'us-central1',
      nowMs: NOW,
      existing: undefined,
    })

    expect(create).toHaveBeenCalledWith({
      displayName: cacheDisplayName(HASH_A, MODEL),
      model: MODEL,
      location: 'us-central1',
      contents: buildCachePrefix(corpus),
      ttlSeconds: STUFF_CACHE_TTL_SECONDS,
    })
  })

  it('reuses an existing valid cache WITHOUT calling create', async () => {
    const { provisioner, create } = fakeProvisioner()
    const existing = recordFor()
    const result = await provisionStuffCache({
      provisioner,
      chunks: corpus,
      corpusBuildHash: HASH_A,
      model: MODEL,
      nowMs: NOW,
      existing,
    })

    expect(create).not.toHaveBeenCalled()
    expect(result.cachedContentName).toBe(existing.name)
    expect(result.record).toEqual(existing)
  })

  it('recreates (calls create) when the build hash changed, keying the new record to the new hash', async () => {
    const { provisioner, create } = fakeProvisioner('projects/p/locations/global/cachedContents/v2')
    const stale = recordFor({ corpusBuildHash: HASH_A })
    const result = await provisionStuffCache({
      provisioner,
      chunks: corpus,
      corpusBuildHash: HASH_B,
      model: MODEL,
      nowMs: NOW,
      existing: stale,
    })

    expect(create).toHaveBeenCalledTimes(1)
    expect(result.record.corpusBuildHash).toBe(HASH_B)
    expect(result.cachedContentName).toBe('projects/p/locations/global/cachedContents/v2')
  })

  it('does not mutate the prior record when recreating (immutability)', async () => {
    const { provisioner } = fakeProvisioner()
    const stale = recordFor({ corpusBuildHash: HASH_A })
    const frozen = Object.freeze({ ...stale })
    const result = await provisionStuffCache({
      provisioner,
      chunks: corpus,
      corpusBuildHash: HASH_B,
      model: MODEL,
      nowMs: NOW,
      existing: frozen,
    })
    expect(stale.corpusBuildHash).toBe(HASH_A)
    expect(result.record).not.toBe(frozen)
  })

  it('persists the Vertex location in the new record so a later region change recreates', async () => {
    const { provisioner } = fakeProvisioner('projects/p/locations/us-central1/cachedContents/x')
    const result = await provisionStuffCache({
      provisioner,
      chunks: corpus,
      corpusBuildHash: HASH_A,
      model: MODEL,
      location: 'us-central1',
      nowMs: NOW,
      existing: undefined,
    })
    expect(result.record.location).toBe('us-central1')
  })
})

describe('resolveStuffCachedContentName — the construction-site threading', () => {
  it('returns undefined (the uncached off-state) when no provisioner is wired', async () => {
    // The live provisioner binds to the Vertex cache-create surface deferred to the
    // live-run milestone; until then the arm runs uncached (the documented off-state,
    // exactly like #16's enrichment access) — the cost stays honest, no cache hit.
    const name = await resolveStuffCachedContentName({
      provisioner: undefined,
      chunks: corpus,
      corpusBuildHash: HASH_A,
      model: MODEL,
      nowMs: NOW,
    })
    expect(name).toBeUndefined()
  })

  it('provisions and returns the resource name when a provisioner is wired', async () => {
    const { provisioner, create } = fakeProvisioner('projects/p/locations/global/cachedContents/w')
    const name = await resolveStuffCachedContentName({
      provisioner,
      chunks: corpus,
      corpusBuildHash: HASH_A,
      model: MODEL,
      nowMs: NOW,
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(name).toBe('projects/p/locations/global/cachedContents/w')
  })

  it('persists the new record via the injected store so the next run can reuse it', async () => {
    const { provisioner } = fakeProvisioner('projects/p/locations/global/cachedContents/persisted')
    const saved: StuffCacheRecord[] = []
    const name = await resolveStuffCachedContentName({
      provisioner,
      chunks: corpus,
      corpusBuildHash: HASH_A,
      model: MODEL,
      nowMs: NOW,
      loadRecord: () => undefined,
      saveRecord: (record) => {
        saved.push(record)
      },
    })
    expect(name).toBe('projects/p/locations/global/cachedContents/persisted')
    expect(saved).toEqual([
      {
        name: 'projects/p/locations/global/cachedContents/persisted',
        corpusBuildHash: HASH_A,
        model: MODEL,
        expiresAtMs: NOW + STUFF_CACHE_TTL_SECONDS * 1000,
      },
    ])
  })

  it('reuses a loaded valid record without creating or re-saving', async () => {
    const { provisioner, create } = fakeProvisioner()
    const existing = recordFor()
    const saved: StuffCacheRecord[] = []
    const name = await resolveStuffCachedContentName({
      provisioner,
      chunks: corpus,
      corpusBuildHash: HASH_A,
      model: MODEL,
      nowMs: NOW,
      loadRecord: () => existing,
      saveRecord: (record) => {
        saved.push(record)
      },
    })
    expect(create).not.toHaveBeenCalled()
    expect(name).toBe(existing.name)
    expect(saved).toEqual([])
  })
})

describe('the cached prefix is a true prefix of the per-question prompt (Codex PR #59)', () => {
  // Locks the contract the deferred live send (AC3/AC4) depends on: Vertex prepends
  // a referenced cache, so a cached call must send ONLY the question suffix, never
  // the full prompt. The decomposition is exact for the `stuff` arm.
  it('reconstructs the full stuff prompt as buildCachePrefix(chunks) + question', () => {
    const question = 'Who is responsible for repairs?'
    const full = buildSynthesisPrompt(question, buildStuffedCandidates(corpus))
    expect(full).toBe(buildCachePrefix(corpus) + question)
    expect(full.startsWith(buildCachePrefix(corpus))).toBe(true)
  })
})
