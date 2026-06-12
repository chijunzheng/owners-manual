import { describe, expect, it, vi } from 'vitest'

import { createVoyageEmbeddingProvider, type VoyageFetch } from './embedding.js'

/** A fake Voyage HTTP response returning one 1024-dim vector per input. */
function fakeVoyageFetch(captured: { calls: unknown[] }): VoyageFetch {
  return async (url, init) => {
    captured.calls.push({ url, body: JSON.parse(String(init.body)) })
    const inputs = JSON.parse(String(init.body)).input as string[]
    const data = inputs.map((_text, i) => ({ embedding: new Array(1024).fill(0.01 * (i + 1)) }))
    return {
      ok: true,
      status: 200,
      json: async () => ({ data, usage: { total_tokens: 7 } }),
      text: async () => '',
    }
  }
}

describe('createVoyageEmbeddingProvider', () => {
  it('reports its model and dimensions for the index build', () => {
    const provider = createVoyageEmbeddingProvider({
      apiKey: 'k',
      model: 'voyage-law-2',
      dimensions: 1024,
      fetch: fakeVoyageFetch({ calls: [] }),
    })
    expect(provider.model).toBe('voyage-law-2')
    expect(provider.dimensions).toBe(1024)
  })

  it('embeds a batch of documents in input order', async () => {
    const captured = { calls: [] as unknown[] }
    const provider = createVoyageEmbeddingProvider({
      apiKey: 'k',
      model: 'voyage-law-2',
      dimensions: 1024,
      fetch: fakeVoyageFetch(captured),
    })
    const vectors = await provider.embedDocuments(['a', 'b'])
    expect(vectors).toHaveLength(2)
    expect(vectors[0]).toHaveLength(1024)
    expect(vectors[1]?.[0]).toBeCloseTo(0.02)
  })

  it('embeds a query with the query input type', async () => {
    const captured = { calls: [] as unknown[] }
    const provider = createVoyageEmbeddingProvider({
      apiKey: 'k',
      model: 'voyage-law-2',
      dimensions: 1024,
      fetch: fakeVoyageFetch(captured),
    })
    const vector = await provider.embedQuery('who repairs the unit?')
    expect(vector).toHaveLength(1024)
    const body = (captured.calls[0] as { body: { input_type?: string } }).body
    expect(body.input_type).toBe('query')
  })

  it('sends the api key as a bearer token, never logging it', async () => {
    const fetchSpy = vi.fn(fakeVoyageFetch({ calls: [] }))
    const provider = createVoyageEmbeddingProvider({
      apiKey: 'secret-key',
      model: 'voyage-law-2',
      dimensions: 1024,
      fetch: fetchSpy,
    })
    await provider.embedQuery('x')
    const init = fetchSpy.mock.calls[0]?.[1] as { headers: Record<string, string> }
    expect(init.headers.authorization).toBe('Bearer secret-key')
  })

  it('throws when the response vector dimension disagrees with the configured one', async () => {
    const provider = createVoyageEmbeddingProvider({
      apiKey: 'k',
      model: 'voyage-law-2',
      dimensions: 999,
      fetch: fakeVoyageFetch({ calls: [] }),
    })
    await expect(provider.embedQuery('x')).rejects.toThrow(/dimension/i)
  })

  it('surfaces a non-200 as an error without echoing the api key', async () => {
    const provider = createVoyageEmbeddingProvider({
      apiKey: 'secret-key',
      model: 'voyage-law-2',
      dimensions: 1024,
      fetch: async () => ({
        ok: false,
        status: 401,
        json: async () => ({}),
        text: async () => 'unauthorized',
      }),
    })
    const error = await provider.embedQuery('x').catch((e: Error) => e)
    expect(String(error)).toMatch(/401/)
    expect(String(error)).not.toContain('secret-key')
  })

  it('retries a 429 (rate limit) with backoff and then succeeds', async () => {
    let attempts = 0
    const flaky: VoyageFetch = async () => {
      attempts += 1
      if (attempts < 3) {
        return { ok: false, status: 429, json: async () => ({}), text: async () => 'rate limited' }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: new Array(1024).fill(0.5) }] }),
        text: async () => '',
      }
    }
    const sleeps: number[] = []
    const provider = createVoyageEmbeddingProvider({
      apiKey: 'k',
      model: 'voyage-law-2',
      dimensions: 1024,
      fetch: flaky,
      maxRetries: 5,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    const vector = await provider.embedQuery('x')
    expect(vector).toHaveLength(1024)
    expect(attempts).toBe(3)
    expect(sleeps.length).toBe(2)
    expect(sleeps[1]).toBeGreaterThan(sleeps[0]!)
  })

  it('gives up after maxRetries 429s, surfacing the status without the key', async () => {
    const always429: VoyageFetch = async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => 'rate limited',
    })
    const provider = createVoyageEmbeddingProvider({
      apiKey: 'secret-key',
      model: 'voyage-law-2',
      dimensions: 1024,
      fetch: always429,
      maxRetries: 2,
      sleep: async () => {},
    })
    const error = await provider.embedQuery('x').catch((e: Error) => e)
    expect(String(error)).toMatch(/429/)
    expect(String(error)).not.toContain('secret-key')
  })

  it('does not retry a non-429 error', async () => {
    let attempts = 0
    const provider = createVoyageEmbeddingProvider({
      apiKey: 'k',
      model: 'voyage-law-2',
      dimensions: 1024,
      fetch: async () => {
        attempts += 1
        return { ok: false, status: 400, json: async () => ({}), text: async () => 'bad' }
      },
      maxRetries: 5,
      sleep: async () => {},
    })
    await provider.embedQuery('x').catch(() => {})
    expect(attempts).toBe(1)
  })
})
