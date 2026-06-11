import { describe, expect, it } from 'vitest'

import { createMemoryCache, type EnrichmentCache } from './cache.js'

/**
 * The per-stage cache (ADR 0004: "per-stage caches keyed to their exact
 * inputs"). It is content-addressed — the key is a hash the caller computes —
 * and it accounts hits vs misses so the build report can prove criterion 1:
 * re-running with unchanged inputs yields 100% cache hits. A miss runs the
 * (expensive, LLM-backed) producer exactly once and stores the result; a hit
 * never calls the producer.
 */

describe('createMemoryCache', () => {
  it('is an EnrichmentCache', () => {
    const cache: EnrichmentCache<string> = createMemoryCache<string>()
    expect(typeof cache.getOrCompute).toBe('function')
    expect(typeof cache.stats).toBe('function')
  })

  it('runs the producer on a miss and stores the value', async () => {
    const cache = createMemoryCache<string>()
    let runs = 0
    const value = await cache.getOrCompute('k1', async () => {
      runs += 1
      return 'computed'
    })
    expect(value).toBe('computed')
    expect(runs).toBe(1)
    expect(cache.stats()).toEqual({ hits: 0, misses: 1 })
  })

  it('serves a hit without running the producer again', async () => {
    const cache = createMemoryCache<string>()
    let runs = 0
    const produce = async () => {
      runs += 1
      return 'v'
    }
    await cache.getOrCompute('k1', produce)
    const second = await cache.getOrCompute('k1', produce)
    expect(second).toBe('v')
    expect(runs).toBe(1)
    expect(cache.stats()).toEqual({ hits: 1, misses: 1 })
  })

  it('treats distinct keys as distinct entries', async () => {
    const cache = createMemoryCache<string>()
    await cache.getOrCompute('a', async () => 'A')
    await cache.getOrCompute('b', async () => 'B')
    expect(cache.stats()).toEqual({ hits: 0, misses: 2 })
  })

  it('reports 100% hits on a full re-run over the same keys', async () => {
    const cache = createMemoryCache<number>()
    const keys = ['x', 'y', 'z']
    for (const k of keys) await cache.getOrCompute(k, async () => k.length)
    cache.resetStats()
    for (const k of keys) await cache.getOrCompute(k, async () => k.length)
    const { hits, misses } = cache.stats()
    expect(misses).toBe(0)
    expect(hits).toBe(keys.length)
  })

  it('can be seeded from a prior snapshot so caches survive across runs', async () => {
    const first = createMemoryCache<string>()
    await first.getOrCompute('k', async () => 'persisted')

    const second = createMemoryCache<string>({ snapshot: first.snapshot() })
    let runs = 0
    const value = await second.getOrCompute('k', async () => {
      runs += 1
      return 'recomputed'
    })
    expect(value).toBe('persisted')
    expect(runs).toBe(0)
    expect(second.stats()).toEqual({ hits: 1, misses: 0 })
  })
})
