/**
 * The live stuffing-arm cache-create binding (#44): a {@link CachedContentProvisioner}
 * that creates a Vertex `CachedContent` over the canonical corpus prefix so the
 * ~900K-token `stuff` prompt is billed once and served from cache thereafter
 * (the `cache_read` discount `stuff-usage.ts` reads).
 *
 * REST, not the SDK, BY DESIGN: `@langchain/google-vertexai` v0.2.x only *consumes*
 * a provisioned `cachedContent` resource name (a string on `ChatVertexAI`) — it
 * exposes no cache-manager surface — and `@google-cloud/vertexai` is not a
 * dependency of this arm. The Vertex caching API (`cachedContents`) is a thin REST
 * POST, so this binds to it directly with ADC-resolved auth via `google-auth-library`
 * (`GoogleAuth` — the SAME keyless ADC mechanism `ChatVertexAI` uses under the hood,
 * ADR 0005), rather than pulling in the heavyweight Vertex SDK for one endpoint.
 *
 * Live by design and not unit-tested (mirrors `ingest-cli.ts` and the other live
 * Vertex bindings): the decision logic, the canonical-prefix assembly, the record
 * persistence, and the suffix-send decomposition are all covered upstream against
 * fakes (`stuff-cache.test.ts`, `stuff-cache-store.test.ts`, `stuff-send.test.ts`).
 * This module only adapts the assembled {@link CreateCachedContentArgs} to one
 * HTTP call and returns the resource name. The live `cachedContents` create + ADC
 * auth are exercised at the live-run milestone (AC3/AC4), not offline.
 */

import { GoogleAuth } from 'google-auth-library'

import { type CachedContentProvisioner, type CreateCachedContentArgs } from '../stuff-cache.js'

/** The cloud-platform scope ADC mints a token for — the same scope ChatVertexAI uses. */
const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'

/**
 * The aiplatform host for a Vertex location. The multi-region `global` endpoint is
 * unprefixed; every other (regional) location prefixes the host with the region —
 * matching the region-scoped resource names context caches live under (Codex PR #59).
 */
function aiplatformHost(location: string): string {
  return location === 'global'
    ? 'aiplatform.googleapis.com'
    : `${location}-aiplatform.googleapis.com`
}

/** The fully-qualified publisher model path the caching API keys the cache to. */
function modelPath(project: string, location: string, model: string): string {
  return `projects/${project}/locations/${location}/publishers/google/models/${model}`
}

/** Minimal shape of the `cachedContents.create` success body (only the name is used). */
interface CachedContentResponse {
  readonly name?: unknown
}

/**
 * Build a {@link CachedContentProvisioner} backed by the Vertex caching REST API.
 * The project resolves from ADC (GOOGLE_CLOUD_PROJECT), the location is passed by
 * the caller (defaulting to `global` upstream). Fail-loud: a missing project, a
 * non-2xx response, or a response without a resource name throws — a silently
 * un-provisioned cache would make the arm bill the full prefix while believing it
 * was cached.
 */
export function createVertexCacheProvisioner(): CachedContentProvisioner {
  const auth = new GoogleAuth({ scopes: VERTEX_SCOPE })

  return {
    async create(args: CreateCachedContentArgs): Promise<{ readonly name: string }> {
      const location = args.location ?? 'global'
      const project = await auth.getProjectId()
      if (!project) {
        throw new Error('Vertex cache create: ADC resolved no GOOGLE_CLOUD_PROJECT')
      }
      const token = await auth.getAccessToken()
      if (!token) {
        throw new Error('Vertex cache create: ADC returned no access token')
      }

      const url = `https://${aiplatformHost(location)}/v1/projects/${project}/locations/${location}/cachedContents`
      const body = {
        model: modelPath(project, location, args.model),
        displayName: args.displayName,
        // One cached user-content block holding the canonical corpus prefix; Vertex
        // prepends it to each referencing request, so the per-question call sends
        // only the variable suffix (see `stuff-send.ts`).
        contents: [{ role: 'user', parts: [{ text: args.contents }] }],
        // Duration string ("Ns") — the REST shape of the cache TTL.
        ttl: `${args.ttlSeconds}s`,
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(
          `Vertex cache create failed (${response.status} ${response.statusText}): ${detail}`,
        )
      }

      const parsed = (await response.json()) as CachedContentResponse
      const name = typeof parsed.name === 'string' ? parsed.name : ''
      if (!name) {
        throw new Error('Vertex cache create returned no resource name')
      }
      return { name }
    },
  }
}
