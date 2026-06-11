/**
 * The per-stage cache (ADR 0004: "per-stage caches keyed to their exact
 * inputs"). It is content-addressed — the caller hands in a key it has already
 * computed (a tree hash, a chunk hash + prompt version, …) — and it accounts
 * hits vs misses so the build report can prove criterion 1: re-running with
 * unchanged inputs yields 100% cache hits.
 *
 * A miss runs the (expensive, LLM-backed) producer exactly once and stores the
 * result under the key; a hit returns the stored value and never calls the
 * producer. A snapshot is an opaque, serializable view of the stored entries so
 * a cache can be persisted between runs and re-seeded — making cross-run hits
 * possible, which is what keeps chunker iteration cheap.
 */

/** Hit/miss tally over the lifetime of a cache (or since the last reset). */
export interface CacheStats {
  readonly hits: number
  readonly misses: number
}

/**
 * A content-addressed memoizing cache: {@link getOrCompute} runs `produce` only
 * on a miss, {@link stats} reports the running hit/miss tally, {@link resetStats}
 * zeroes it without dropping entries, and {@link snapshot} exports the entries so
 * the cache can survive across runs.
 */
export interface EnrichmentCache<T> {
  /** Return the value for `key`, running `produce` exactly once iff it is absent. */
  getOrCompute(key: string, produce: () => Promise<T>): Promise<T>
  /** The hit/miss tally since construction or the last {@link resetStats}. */
  stats(): CacheStats
  /** Zero the hit/miss tally without evicting any stored entries. */
  resetStats(): void
  /** An opaque, serializable view of the stored entries, for persistence. */
  snapshot(): CacheSnapshot<T>
}

/** A serializable view of a cache's stored entries, for re-seeding a later run. */
export type CacheSnapshot<T> = Readonly<Record<string, T>>

/** Construction options: optionally seed the cache from a prior {@link CacheSnapshot}. */
export interface MemoryCacheOptions<T> {
  readonly snapshot?: CacheSnapshot<T>
}

/**
 * An in-memory {@link EnrichmentCache}. Seeded entries count as hits when first
 * served — a re-run over an unchanged corpus is therefore all hits and zero
 * producer calls, which is exactly the property the build report asserts.
 *
 * Snapshots are copied in and out so the cache never shares mutable state with a
 * caller's object; producers' results are stored by reference (the cache owns
 * the value it produced).
 */
export function createMemoryCache<T>(options: MemoryCacheOptions<T> = {}): EnrichmentCache<T> {
  const store = new Map<string, T>(Object.entries(options.snapshot ?? {}))
  let hits = 0
  let misses = 0

  return {
    async getOrCompute(key, produce) {
      if (store.has(key)) {
        hits += 1
        return store.get(key) as T
      }
      misses += 1
      const value = await produce()
      store.set(key, value)
      return value
    },
    stats() {
      return { hits, misses }
    },
    resetStats() {
      hits = 0
      misses = 0
    },
    snapshot() {
      return Object.fromEntries(store)
    },
  }
}
