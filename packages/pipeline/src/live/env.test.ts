import { describe, expect, it } from 'vitest'

import { langfuseEnabled, resolveCohereApiKey } from './env.js'

describe('langfuseEnabled', () => {
  it('is true when both keys are present and not placeholders', () => {
    expect(
      langfuseEnabled({ LANGFUSE_PUBLIC_KEY: 'pk-lf-real', LANGFUSE_SECRET_KEY: 'sk-lf-real' }),
    ).toBe(true)
  })

  it('is false when a key is still a placeholder', () => {
    expect(
      langfuseEnabled({
        LANGFUSE_PUBLIC_KEY: 'pk-lf-PLACEHOLDER-REPLACE-ME',
        LANGFUSE_SECRET_KEY: 'sk-lf-real',
      }),
    ).toBe(false)
  })

  it('is false when a key is missing', () => {
    expect(langfuseEnabled({ LANGFUSE_PUBLIC_KEY: 'pk-lf-real' })).toBe(false)
  })

  it('is false when explicitly disabled via NAIVE_RAG_NO_LANGFUSE', () => {
    expect(
      langfuseEnabled({
        LANGFUSE_PUBLIC_KEY: 'pk-lf-real',
        LANGFUSE_SECRET_KEY: 'sk-lf-real',
        NAIVE_RAG_NO_LANGFUSE: '1',
      }),
    ).toBe(false)
  })
})

describe('resolveCohereApiKey', () => {
  it('returns the key when set and not a placeholder', () => {
    expect(resolveCohereApiKey({ COHERE_API_KEY: 'co-real-key' })).toBe('co-real-key')
  })

  it('returns undefined when the key is still the example placeholder', () => {
    expect(resolveCohereApiKey({ COHERE_API_KEY: 'PLACEHOLDER-REPLACE-ME' })).toBeUndefined()
  })

  it('returns undefined when the key is unset (rerank degrades to authority)', () => {
    expect(resolveCohereApiKey({})).toBeUndefined()
  })
})
