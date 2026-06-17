/**
 * The stuffing-arm context-cache LIFECYCLE (#44) — the pure half.
 *
 * The stuffing arms (`stuff` / `stuff-oracle`) place the whole ~900K-token corpus
 * prefix in the model's context for every question. Without a context cache that
 * prefix is re-billed per question; with one, the fixed prefix is billed once and
 * served from cache (the `cache_read` discount `stuff-usage.ts` reads). This module
 * owns the decision of WHEN a `CachedContent` may be reused versus recreated, the
 * deterministic assembly of the canonical prefix it must cover, and the
 * orchestration of provisioning — all PURE, over an INJECTED provisioner seam, so
 * the lifecycle is unit-tested without a live Vertex call.
 *
 * What is deliberately NOT here (live-only, deferred to the live-run milestone,
 * same pattern as #16's enrichment lookup and #18's interim): the real Vertex
 * `CachedContent` create/refresh REST/SDK call. `@langchain/google-vertexai`
 * v0.2.x only *consumes* a provisioned `cachedContent` resource name (a string) —
 * it exposes no cache-manager surface — so the create call binds to the Vertex
 * caching API behind the {@link CachedContentProvisioner} seam at the construction
 * site. AC3 (live `cache_read` usage + discounted cost-per-question) and AC4
 * (end-to-end against live Vertex) are exercised at that milestone, not offline.
 *
 * The cache is KEYED to the corpus build hash (ADR 0004 — a build is
 * `hash(manifest + pipeline config)`): a build change recreates the cache, so the
 * stuffed prefix and the cache can never silently diverge.
 */

import { type CorpusChunk } from './chunk-corpus.js'
import { buildStuffedCandidates } from './stuff-synthesis.js'
import { buildSynthesisPrompt } from './synthesize.js'

/**
 * The cache time-to-live, in seconds. Tied to the eval build cadence rather than a
 * dollar figure: a corpus build is content-addressed and changes only on a
 * manifest/config edit (a re-ingest — infrequent), while a single matrix/ladder
 * run sweeps every golden question over hours against ONE build. 24h comfortably
 * covers a full day-long run against one build, and bounds the stale-cache window
 * if a build is abandoned. Orthogonal to invalidation: {@link decideCacheAction}
 * recreates immediately on a build-hash or model change regardless of remaining
 * TTL — the TTL only caps how long an *unchanged* build's cache survives.
 */
export const STUFF_CACHE_TTL_SECONDS = 24 * 60 * 60

/**
 * A persisted note of the live cache currently provisioned for a build: the Vertex
 * resource name, the build hash + model it was keyed to, and when it expires. The
 * lifecycle compares the live build against this to decide reuse vs recreate.
 */
export interface StuffCacheRecord {
  /** The Vertex `CachedContent` resource name (`projects/…/cachedContents/…`). */
  readonly name: string
  /** The corpus build hash this cache covers (ADR 0004). */
  readonly corpusBuildHash: string
  /** The product model the cache was created for (a model swap invalidates it). */
  readonly model: string
  /**
   * The Vertex location the cache was created in. Context caches are REGION-scoped
   * and the resource name is location-scoped, so a location change must recreate —
   * reusing a name from another region points at a cache that isn't there (Codex
   * PR #59). Undefined when no location was pinned (ADC-resolved).
   */
  readonly location?: string
  /** Wall-clock expiry (ms since epoch) — the TTL applied at create time. */
  readonly expiresAtMs: number
}

/** The arguments a live create call needs — assembled purely, consumed by the seam. */
export interface CreateCachedContentArgs {
  /** A human-identifiable name embedding the build hash (so a stale cache is visible). */
  readonly displayName: string
  /** The product model the cache is bound to. */
  readonly model: string
  /** The Vertex location, when the caller pins one (ADC resolves the project). */
  readonly location?: string
  /** The canonical corpus prefix the cache covers, in fixed canonical order. */
  readonly contents: string
  /** The cache TTL in seconds. */
  readonly ttlSeconds: number
}

/**
 * The injectable seam over the live Vertex cache-create surface. A fake implements
 * it in tests (create/refresh/reuse exercised with no live call); the live serve
 * binding implements it against the Vertex caching API at the construction site.
 * Returns only the provisioned resource name — everything else the record needs is
 * known purely from the request.
 */
export interface CachedContentProvisioner {
  create(args: CreateCachedContentArgs): Promise<{ readonly name: string }>
}

/** Whether the existing cache can be reused as-is, or must be recreated. */
export type CacheAction = 'reuse' | 'recreate'

/**
 * Assemble the canonical corpus prefix the cache must cover. This is byte-for-byte
 * the SOURCES block the `stuff` arm sends (canonical order, the same
 * {@link buildStuffedCandidates} + {@link buildSynthesisPrompt} rendering the arm
 * uses with an empty question), so the cached prefix and the per-question prompt
 * prefix are identical — the precondition for a `cache_read` hit. Deterministic by
 * construction: the same chunks in the same order always yield the same string.
 *
 * LIVE SEND CONTRACT (deferred to AC3/AC4, Codex PR #59): Vertex prepends a
 * referenced `cachedContent` to the request, so a cached call must send ONLY the
 * variable suffix — the question — NOT the full {@link buildSynthesisPrompt}, or
 * the instructions+SOURCES are sent twice. The decomposition is exact and pinned
 * in the unit suite: `buildSynthesisPrompt(q, …) === buildCachePrefix(chunks) + q`.
 * This single full-corpus cache cleanly fits the `stuff` arm (its prompt IS this
 * prefix + the question); it does NOT fit `stuff-oracle`, which routes a SUBSET of
 * the corpus, so its prompt is not this prefix + a suffix — oracle needs its own
 * cache or must run uncached. Wiring the live send (and the per-arm cache strategy)
 * is the live-run-milestone decision tracked on #44; today no cache is referenced.
 */
export function buildCachePrefix(chunks: readonly CorpusChunk[]): string {
  if (chunks.length === 0) {
    throw new Error('cannot build a context cache over an empty corpus (a build bug)')
  }
  return buildSynthesisPrompt('', buildStuffedCandidates(chunks))
}

/**
 * The cache's human-identifiable display name — embeds the build hash and the
 * model so a stale or wrong-model cache is identifiable at a glance in the Vertex
 * console and the decision logic. Distinct builds and distinct models name
 * distinct caches.
 */
export function cacheDisplayName(corpusBuildHash: string, model: string): string {
  return `owners-manual/stuff/${model}/${corpusBuildHash}`
}

export interface DecideCacheActionOptions {
  /** The cache currently provisioned, if any. */
  readonly existing: StuffCacheRecord | undefined
  /** The live corpus build hash to key against. */
  readonly corpusBuildHash: string
  /** The live product model. */
  readonly model: string
  /** The live Vertex location to key against (region-scoped caches). */
  readonly location?: string
  /** Current wall-clock time (ms since epoch). */
  readonly nowMs: number
}

/**
 * Decide reuse vs recreate. Recreate when there is no cache, when the corpus build
 * hash changed (the prefix the cache covers is stale — ADR 0004), when the model
 * changed (a cache is model-bound), when the Vertex location changed (context
 * caches are region-scoped, so a name from another region is unreachable — Codex
 * PR #59), or when the TTL has elapsed (expiry is inclusive — at the exact expiry
 * instant the cache is treated as expired). Pure.
 */
export function decideCacheAction(options: DecideCacheActionOptions): CacheAction {
  const { existing, corpusBuildHash, model, location, nowMs } = options
  if (existing === undefined) return 'recreate'
  if (existing.corpusBuildHash !== corpusBuildHash) return 'recreate'
  if (existing.model !== model) return 'recreate'
  if (existing.location !== location) return 'recreate'
  if (existing.expiresAtMs <= nowMs) return 'recreate'
  return 'reuse'
}

export interface ProvisionStuffCacheOptions {
  /** The seam over the live cache-create surface (faked in tests). */
  readonly provisioner: CachedContentProvisioner
  /** The corpus chunks the cache covers, in fixed canonical order. */
  readonly chunks: readonly CorpusChunk[]
  /** The live corpus build hash to key the cache to (ADR 0004). */
  readonly corpusBuildHash: string
  /** The live product model. */
  readonly model: string
  /** The Vertex location, when pinned. */
  readonly location?: string
  /** Current wall-clock time (ms since epoch). */
  readonly nowMs: number
  /** The cache currently provisioned, if any. */
  readonly existing: StuffCacheRecord | undefined
}

export interface ProvisionStuffCacheResult {
  /** The resource name to thread into the live stuffing LLM (`cachedContentName`). */
  readonly cachedContentName: string
  /** The (possibly new) record to persist for the next provisioning decision. */
  readonly record: StuffCacheRecord
}

/**
 * Provision the stuffing-arm context cache for the live build: reuse the existing
 * cache when {@link decideCacheAction} says so (no create call), otherwise create a
 * fresh `CachedContent` over the canonical prefix via the injected seam and return
 * a NEW record keyed to the current build hash + model with a fresh expiry.
 * Immutable — never mutates the prior record. Pure over the seam: no live call here.
 */
export async function provisionStuffCache(
  options: ProvisionStuffCacheOptions,
): Promise<ProvisionStuffCacheResult> {
  const { provisioner, chunks, corpusBuildHash, model, location, nowMs, existing } = options

  const action = decideCacheAction({
    existing,
    corpusBuildHash,
    model,
    ...(location !== undefined ? { location } : {}),
    nowMs,
  })
  if (action === 'reuse' && existing !== undefined) {
    return { cachedContentName: existing.name, record: existing }
  }

  const { name } = await provisioner.create({
    displayName: cacheDisplayName(corpusBuildHash, model),
    model,
    ...(location !== undefined ? { location } : {}),
    contents: buildCachePrefix(chunks),
    ttlSeconds: STUFF_CACHE_TTL_SECONDS,
  })

  const record: StuffCacheRecord = {
    name,
    corpusBuildHash,
    model,
    // Persist the location so a later region change recreates rather than reusing
    // a name from another region (Codex PR #59).
    ...(location !== undefined ? { location } : {}),
    expiresAtMs: nowMs + STUFF_CACHE_TTL_SECONDS * 1000,
  }
  return { cachedContentName: name, record }
}

export interface ResolveStuffCachedContentNameOptions {
  /**
   * The live cache-create seam. UNDEFINED is the documented off-state: no cache is
   * provisioned and the arm runs uncached (honest cost, no `cache_read`) — the same
   * deferral shape as #16's enrichment access, until the live Vertex cache binding
   * lands at the live-run milestone.
   */
  readonly provisioner: CachedContentProvisioner | undefined
  /** The corpus chunks the cache covers, in fixed canonical order. */
  readonly chunks: readonly CorpusChunk[]
  /** The live corpus build hash to key the cache to (ADR 0004). */
  readonly corpusBuildHash: string
  /** The live product model. */
  readonly model: string
  /** The Vertex location, when pinned. */
  readonly location?: string
  /** Current wall-clock time (ms since epoch). */
  readonly nowMs: number
  /** Load the last persisted cache record (the prior provisioning decision). */
  readonly loadRecord?: () => StuffCacheRecord | undefined
  /** Persist a freshly created record so the next run can reuse it. */
  readonly saveRecord?: (record: StuffCacheRecord) => void
}

/**
 * Resolve the `cachedContentName` to thread into `createVertexStuffLlm` at the
 * construction site. With no provisioner wired, returns `undefined` (the uncached
 * off-state). Otherwise it provisions (reuse vs recreate via {@link provisionStuffCache}),
 * persists a newly created record through the injected store, and returns the
 * resource name. A reused record is not re-saved (it is already persisted).
 */
export async function resolveStuffCachedContentName(
  options: ResolveStuffCachedContentNameOptions,
): Promise<string | undefined> {
  const { provisioner, chunks, corpusBuildHash, model, location, nowMs, loadRecord, saveRecord } =
    options
  if (provisioner === undefined) return undefined

  const existing = loadRecord?.()
  const { cachedContentName, record } = await provisionStuffCache({
    provisioner,
    chunks,
    corpusBuildHash,
    model,
    ...(location !== undefined ? { location } : {}),
    nowMs,
    existing,
  })
  if (record !== existing) saveRecord?.(record)
  return cachedContentName
}
