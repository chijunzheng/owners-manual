import { describe, expect, it } from 'vitest'

import { fakeClaudeClient, type ClaudeClient } from './claude-client.js'

/**
 * Every Claude call in this track goes through an injected {@link ClaudeClient}.
 * No live LLM runs in CI (the SDK credit window opens later and no keys exist in
 * this checkout), so the whole offline track is built against this seam and a
 * deterministic fake. The fake records each request so tests can assert *how*
 * Claude is invoked — per document, with chunks batched, never one call per
 * chunk (ADR 0005).
 */

describe('fakeClaudeClient', () => {
  it('is a ClaudeClient', () => {
    const client: ClaudeClient = fakeClaudeClient()
    expect(typeof client.model).toBe('string')
    expect(typeof client.complete).toBe('function')
  })

  it('returns a deterministic completion for the same request', async () => {
    const client = fakeClaudeClient()
    const a = await client.complete({ system: 's', user: 'hello' })
    const b = await client.complete({ system: 's', user: 'hello' })
    expect(a.text).toBe(b.text)
  })

  it('records every request in call order', async () => {
    const client = fakeClaudeClient()
    await client.complete({ system: 's', user: 'one' })
    await client.complete({ system: 's', user: 'two' })
    expect(client.calls.map((c) => c.user)).toEqual(['one', 'two'])
  })

  it('reports the pinned model string it was constructed with', () => {
    const client = fakeClaudeClient({ model: 'claude-test-0' })
    expect(client.model).toBe('claude-test-0')
  })

  it('can be scripted with canned responses keyed by a marker in the prompt', async () => {
    const client = fakeClaudeClient({
      responder: (req) => (req.user.includes('XREF') ? '{"edges":[]}' : 'default'),
    })
    expect((await client.complete({ system: 's', user: 'do XREF now' })).text).toBe('{"edges":[]}')
    expect((await client.complete({ system: 's', user: 'something else' })).text).toBe('default')
  })
})
