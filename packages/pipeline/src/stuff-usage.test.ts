import { describe, expect, it } from 'vitest'

import { mapVertexUsage } from './stuff-usage.js'

describe('mapVertexUsage', () => {
  it('maps LangChain usage_metadata into the stuff usage shape, reading the cache hit', () => {
    const usage = mapVertexUsage({
      input_tokens: 1000,
      output_tokens: 50,
      total_tokens: 1050,
      input_token_details: { cache_read: 900 },
    })
    expect(usage).toEqual({ promptTokens: 1000, cachedPromptTokens: 900, completionTokens: 50 })
  })

  it('treats a missing cache_read as zero cached tokens (no caching that call)', () => {
    const usage = mapVertexUsage({ input_tokens: 1000, output_tokens: 50, total_tokens: 1050 })
    expect(usage.cachedPromptTokens).toBe(0)
  })

  it('treats absent usage metadata as all zeros rather than throwing', () => {
    expect(mapVertexUsage(undefined)).toEqual({
      promptTokens: 0,
      cachedPromptTokens: 0,
      completionTokens: 0,
    })
  })
})
