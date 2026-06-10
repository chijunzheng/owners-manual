import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the Langfuse SDK so this test is CI-safe: no server, no secrets, no
// network. Mocks are created via vi.hoisted so they exist when the (hoisted)
// vi.mock factory runs.
const { LangfuseMock, trace, flushAsync } = vi.hoisted(() => {
  const traceSpanEnd = vi.fn()
  const span = vi.fn(() => ({ end: traceSpanEnd }))
  const traceFn = vi.fn(() => ({ id: 'trace-test-id', update: vi.fn(), span }))
  const flush = vi.fn(async () => undefined)
  const ctor = vi.fn(() => ({
    trace: traceFn,
    span,
    flushAsync: flush,
    shutdownAsync: vi.fn(async () => undefined),
  }))
  return { LangfuseMock: ctor, trace: traceFn, flushAsync: flush }
})

vi.mock('langfuse', () => ({ Langfuse: LangfuseMock }))

import { emitHelloTrace, HELLO_TRACE_NAME } from './hello-trace.js'

/** First positional arg of a mock's first call, typed as the caller expects. */
function firstCallArg<T>(mockFn: { mock: { calls: unknown[][] } }): T {
  const args = mockFn.mock.calls[0]
  expect(args, 'mock was not called').toBeDefined()
  return (args as unknown[])[0] as T
}

describe('emitHelloTrace (TS SDK hello trace — AC2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('constructs the Langfuse client from the standard env contract', async () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-test')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-test')
    vi.stubEnv('LANGFUSE_HOST', 'http://localhost:3000')

    await emitHelloTrace()

    expect(LangfuseMock).toHaveBeenCalledTimes(1)
    const config = firstCallArg<Record<string, unknown>>(LangfuseMock)
    expect(config.publicKey).toBe('pk-lf-test')
    expect(config.secretKey).toBe('sk-lf-test')
    expect(config.baseUrl).toBe('http://localhost:3000')
  })

  it('emits exactly one named trace', async () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-test')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-test')

    await emitHelloTrace()

    expect(trace).toHaveBeenCalledTimes(1)
    const traceArg = firstCallArg<{ name?: string }>(trace)
    expect(traceArg.name).toBe(HELLO_TRACE_NAME)
  })

  it('flushes before resolving so the trace is durably sent', async () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-test')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-test')

    await emitHelloTrace()

    expect(flushAsync).toHaveBeenCalledTimes(1)
  })

  it('returns the trace id and resolved host for the caller to print', async () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-test')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-test')
    vi.stubEnv('LANGFUSE_HOST', 'http://localhost:3000')

    const result = await emitHelloTrace()

    expect(result.traceId).toBe('trace-test-id')
    expect(result.host).toBe('http://localhost:3000')
  })

  it('falls back to the local self-host URL when LANGFUSE_HOST is unset', async () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', 'pk-lf-test')
    vi.stubEnv('LANGFUSE_SECRET_KEY', 'sk-lf-test')
    vi.stubEnv('LANGFUSE_HOST', '')

    const result = await emitHelloTrace()

    expect(result.host).toBe('http://localhost:3000')
    const config = firstCallArg<Record<string, unknown>>(LangfuseMock)
    expect(config.baseUrl).toBe('http://localhost:3000')
  })

  it('fails fast with a clear message when credentials are missing', async () => {
    vi.stubEnv('LANGFUSE_PUBLIC_KEY', '')
    vi.stubEnv('LANGFUSE_SECRET_KEY', '')

    await expect(emitHelloTrace()).rejects.toThrow(/LANGFUSE_PUBLIC_KEY/)
    expect(LangfuseMock).not.toHaveBeenCalled()
  })
})
