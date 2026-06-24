/**
 * The stuffing-arm LIVE SEND CONTRACT (#44, Codex PR #59) — the pure half.
 *
 * Vertex prepends a referenced `cachedContent` to the request, so a cached
 * `/stuff` call must send ONLY the variable suffix — what remains after the fixed
 * corpus prefix the cache covers — never the full {@link buildSynthesisPrompt}, or
 * the instructions + SOURCES are sent twice (double-billed, and the model sees the
 * corpus twice). The decomposition is exact for the `stuff` arm:
 * `buildSynthesisPrompt(q, buildStuffedCandidates(chunks)) === buildCachePrefix(chunks) + suffix`
 * — pinned in `stuff-cache.test.ts` and `stuff-send.test.ts`.
 *
 * This module owns the PURE selection: a {@link StuffLlmComplete} decorator that,
 * when a cache prefix is known, strips it from the prompt before delegating to the
 * inner (live Vertex) completion, and otherwise passes the full prompt through
 * unchanged. The live binding only references the `cachedContentName` on the chat
 * client; the prefix-stripping that keeps the send honest lives here, so it is
 * unit-tested against a fake LLM rather than a live Vertex call. Fail-loud: if a
 * cache is referenced but the prompt does not start with the cached prefix (a stale
 * cache, or the order-permutation probe whose SOURCES are reordered), it throws
 * rather than silently double-sending or sending a truncated body.
 */

import { type StuffLlmComplete } from './stuff-synthesis.js'

/**
 * The variable suffix to send on a cached call: exactly what remains after the
 * cached `prefix`. Throws when `prompt` does not start with `prefix` — a divergence
 * means the cache and the per-question prompt have drifted (a stale cache or a
 * non-canonical chunk order), which must fail loud, never silently truncate.
 */
export function deriveStuffSendSuffix(prompt: string, prefix: string): string {
  if (!prompt.startsWith(prefix)) {
    throw new Error(
      'cached stuff prompt does not start with the cached corpus prefix — the cache and the ' +
        'per-question prompt have diverged (a stale cache or a non-canonical chunk order)',
    )
  }
  return prompt.slice(prefix.length)
}

/**
 * Wrap an inner {@link StuffLlmComplete} so a cached call sends only the suffix and
 * an uncached call sends the full prompt. With `cachePrefix` undefined (no cache
 * provisioned — the documented off-state) the prompt passes through verbatim, so
 * the uncached cost stays honest. With a prefix set, the corpus prefix is stripped
 * and the suffix delegated to `inner` (Vertex prepends the referenced cache). Pure
 * over the injected `inner`: no live call here.
 */
export function withCachedPrefixStripped(
  inner: StuffLlmComplete,
  cachePrefix: string | undefined,
): StuffLlmComplete {
  if (cachePrefix === undefined) return inner
  // `async` so a prefix divergence surfaces as a rejected promise (the seam is
  // promise-returning), never a synchronous throw the caller's `await` can miss.
  return async (prompt: string) => inner(deriveStuffSendSuffix(prompt, cachePrefix))
}
