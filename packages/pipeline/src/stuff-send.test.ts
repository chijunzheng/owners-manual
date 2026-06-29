import { describe, expect, it, vi } from 'vitest'

import { type CorpusChunk } from './chunk-corpus.js'
import { buildCachePrefix } from './stuff-cache.js'
import { deriveStuffSendSuffix, withCachedPrefixStripped } from './stuff-send.js'
import {
  buildStuffedCandidates,
  type StuffLlmComplete,
  type StuffUsage,
} from './stuff-synthesis.js'
import { buildSynthesisPrompt } from './synthesize.js'

// The stuffing-arm LIVE SEND CONTRACT (#44, Codex PR #59). Vertex prepends a
// referenced `cachedContent` to the request, so a cached `/stuff` call must send
// ONLY the variable suffix (what remains after the canonical corpus prefix) — never
// the full `buildSynthesisPrompt`, or the instructions + SOURCES are sent twice.
// The decomposition is exact and PURE, so it is pinned here against a fake LLM; the
// live `ChatVertexAI` binding only adapts it to one client.

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

const USAGE: StuffUsage = { promptTokens: 10, cachedPromptTokens: 9, completionTokens: 2 }

/** A fake inner LLM that records the prompt it was sent; never touches Vertex. */
function fakeLlm(): {
  readonly complete: StuffLlmComplete
  readonly sent: ReturnType<typeof vi.fn>
} {
  const sent = vi.fn(async () => ({ text: '{}', usage: USAGE }))
  return { complete: sent, sent }
}

describe('deriveStuffSendSuffix — the variable suffix after the cached prefix', () => {
  it('returns exactly what remains after the prefix (the identity holds)', () => {
    const question = 'Who is responsible for repairs?'
    const full = buildSynthesisPrompt(question, buildStuffedCandidates(corpus))
    const prefix = buildCachePrefix(corpus)
    expect(deriveStuffSendSuffix(full, prefix)).toBe(question)
    // The decomposition is exact: prefix + suffix reconstructs the full prompt.
    expect(prefix + deriveStuffSendSuffix(full, prefix)).toBe(full)
  })

  it('throws when the prompt does not start with the prefix (a divergence is a build bug)', () => {
    // The cache prefix is built from the canonical corpus order; a prompt whose
    // SOURCES diverge (a stale cache, or the order-permutation probe) must fail
    // LOUD rather than silently double-send or send a truncated body.
    const prefix = buildCachePrefix(corpus)
    const diverged = buildCachePrefix([governing, tenancy]) + 'q'
    expect(() => deriveStuffSendSuffix(diverged, prefix)).toThrow(/prefix/i)
  })
})

describe('withCachedPrefixStripped — selects the cached (suffix) vs uncached (full) send', () => {
  it('sends ONLY the suffix to the inner LLM when a cache prefix is supplied', async () => {
    const { complete, sent } = fakeLlm()
    const question = 'Who is responsible for repairs?'
    const full = buildSynthesisPrompt(question, buildStuffedCandidates(corpus))
    const cached = withCachedPrefixStripped(complete, buildCachePrefix(corpus))

    const result = await cached(full)
    expect(sent).toHaveBeenCalledTimes(1)
    expect(sent).toHaveBeenCalledWith(question) // suffix only — Vertex prepends the cache
    expect(result.usage).toEqual(USAGE)
  })

  it('passes the FULL prompt through unchanged when no cache prefix is supplied (uncached)', async () => {
    const { complete, sent } = fakeLlm()
    const question = 'Who is responsible for repairs?'
    const full = buildSynthesisPrompt(question, buildStuffedCandidates(corpus))
    const uncached = withCachedPrefixStripped(complete, undefined)

    await uncached(full)
    expect(sent).toHaveBeenCalledWith(full) // unchanged — no cache referenced
  })

  it('fails loud when a cache is referenced but the prompt diverges from the prefix', async () => {
    const { complete } = fakeLlm()
    const cached = withCachedPrefixStripped(complete, buildCachePrefix(corpus))
    const diverged = buildCachePrefix([governing, tenancy]) + 'q'
    await expect(cached(diverged)).rejects.toThrow(/prefix/i)
  })
})
