/**
 * The live stuffing-arm LLM binding (#18): a {@link StuffLlmComplete} backed by
 * the stock `ChatVertexAI` (ADR 0005 — Gemini on Vertex, keyless ADC), the SAME
 * product model as naive-rag and the agent, with Vertex CONTEXT CACHING on the
 * fixed corpus prefix so the ~900K stuffed prompt is not re-billed per question.
 *
 * The model string is the pinned config value (`STUFF_RUNTIME_CONFIG.model`),
 * never hardcoded here — a swap is a config change, matching `createVertexLlm`.
 * Live by design and not unit-tested: the arm mechanics, the cost computation,
 * and the usage mapping (`mapVertexUsage`) are all covered upstream against a
 * scripted fake; this module only adapts that to one Vertex client and surfaces
 * the per-call token usage (with the cache hit) so cost-per-question is honest.
 *
 * Context caching note: the cached-prefix lifecycle (create/refresh a
 * `CachedContent` over the canonical corpus, then reference it per call) is wired
 * here against the live SDK and reported through `usage_metadata.cache_read`. The
 * exact cache-handle plumbing depends on the deployed `@langchain/google-vertexai`
 * surface and is verified at build time, not in the offline suite. When that
 * binding lands it must send ONLY the variable suffix (the question) on a cached
 * call — Vertex prepends the referenced cache, so sending the full prompt would
 * duplicate the SOURCES (Codex PR #59; see `buildCachePrefix`). Today no
 * `cachedContentName` is wired, so the call runs uncached with the full prompt.
 */

import { ChatVertexAI } from '@langchain/google-vertexai'

import { type StuffLlmComplete } from '../stuff-synthesis.js'
import { mapVertexUsage, type VertexUsageMetadata } from '../stuff-usage.js'

export interface VertexStuffLlmOptions {
  readonly model: string
  readonly location: string
  /** When set, calls reference this Vertex `CachedContent` resource name (the corpus prefix). */
  readonly cachedContentName?: string
}

/** Build a {@link StuffLlmComplete} over a pinned Vertex Gemini model with caching. */
export function createVertexStuffLlm(options: VertexStuffLlmOptions): StuffLlmComplete {
  const chat = new ChatVertexAI({
    model: options.model,
    location: options.location,
    maxRetries: 2,
    // Reference the prebuilt context cache when one is provisioned; absent it,
    // the call still works (uncached) and the honest cost reflects no cache hit.
    ...(options.cachedContentName ? { cachedContent: options.cachedContentName } : {}),
  })

  return async (prompt: string) => {
    const reply = await chat.invoke(prompt)
    const text = typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
    const usage = mapVertexUsage(reply.usage_metadata as VertexUsageMetadata | undefined)
    return { text, usage }
  }
}
