import { describe, expect, it } from 'vitest'

import { createLangfuseTracer, type LangfuseLikeClient } from './langfuse-tracer.js'

const env = {
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  LANGFUSE_HOST: 'http://localhost:3000',
}

interface Call {
  readonly kind: 'trace' | 'root-span' | 'child-span' | 'update' | 'end'
  readonly args?: unknown
}

/** A fake Langfuse client recording every call for assertion. */
function fakeClient(): { client: LangfuseLikeClient; calls: Call[] } {
  const calls: Call[] = []
  const makeSpan = (kind: 'root-span' | 'child-span', args: unknown): never => {
    calls.push({ kind, args })
    return {
      span: (childArgs: unknown) => makeSpan('child-span', childArgs),
      update: (fields: unknown) => calls.push({ kind: 'update', args: fields }),
      end: () => calls.push({ kind: 'end' }),
    } as never
  }
  const client = {
    trace: (args: unknown) => {
      calls.push({ kind: 'trace', args })
      return {
        span: (childArgs: unknown) => makeSpan('child-span', childArgs),
        update: (fields: unknown) => calls.push({ kind: 'update', args: fields }),
      }
    },
    span: (args: unknown) => makeSpan('root-span', args),
    flushAsync: async () => {},
    shutdownAsync: async () => {},
  } as LangfuseLikeClient
  return { client, calls }
}

describe('createLangfuseTracer', () => {
  it('throws without credentials', () => {
    expect(() => createLangfuseTracer({})).toThrow(/LANGFUSE_PUBLIC_KEY/)
  })

  it('creates a trace with the propagated id when no parent span is given', () => {
    const { client, calls } = fakeClient()
    const handle = createLangfuseTracer(env, client)
    const trace = handle.tracer.startTrace({ name: 'n', traceId: 'a'.repeat(32), input: { q: 1 } })
    trace.span('retrieve').end()
    trace.setOutput({ done: true })

    expect(calls[0]?.kind).toBe('trace')
    expect(calls[0]?.args).toMatchObject({ id: 'a'.repeat(32), name: 'n' })
    expect(calls.some((c) => c.kind === 'root-span')).toBe(false)
  })

  it('nests under the harness span when a parent span id is propagated (no trace upsert)', () => {
    const { client, calls } = fakeClient()
    const handle = createLangfuseTracer(env, client)
    const trace = handle.tracer.startTrace({
      name: 'owners-manual.naive-rag',
      traceId: 'a'.repeat(32),
      parentSpanId: 'b'.repeat(16),
      input: { q: 1 },
    })
    trace.span('retrieve').end()
    trace.setOutput({ done: true })

    // The harness owns the trace: the service must NOT upsert trace-level fields.
    expect(calls.some((c) => c.kind === 'trace')).toBe(false)
    expect(calls[0]?.kind).toBe('root-span')
    expect(calls[0]?.args).toMatchObject({
      traceId: 'a'.repeat(32),
      parentObservationId: 'b'.repeat(16),
      name: 'owners-manual.naive-rag',
    })
    // Stage spans become children of the service root span.
    expect(calls.some((c) => c.kind === 'child-span')).toBe(true)
    // setOutput updates and closes the service root span.
    expect(calls.filter((c) => c.kind === 'update')).toHaveLength(1)
    expect(calls.at(-1)?.kind).toBe('end')
  })

  it('falls back to trace mode when a parent span id arrives without a trace id', () => {
    const { client, calls } = fakeClient()
    const handle = createLangfuseTracer(env, client)
    handle.tracer.startTrace({ name: 'n', parentSpanId: 'b'.repeat(16) })
    expect(calls[0]?.kind).toBe('trace')
  })

  it('tags a root-mode trace with the naive-rag arm by default', () => {
    const { client, calls } = fakeClient()
    createLangfuseTracer(env, client).tracer.startTrace({ name: 'n', traceId: 'a'.repeat(32) })
    expect(calls[0]?.args).toMatchObject({ tags: ['naive-rag', 'arm:naive-rag'] })
  })

  it('tags a root-mode trace with the agent arm when agent tags are supplied (#15)', () => {
    const { client, calls } = fakeClient()
    const handle = createLangfuseTracer(env, client, ['agent', 'arm:agent'])
    handle.tracer.startTrace({ name: 'owners-manual.agent', traceId: 'a'.repeat(32) })
    expect(calls[0]?.args).toMatchObject({ tags: ['agent', 'arm:agent'] })
  })

  it('writes a child-span output through the SDK update call in root mode', () => {
    const { client, calls } = fakeClient()
    const handle = createLangfuseTracer(env, client)
    const trace = handle.tracer.startTrace({ name: 'n', traceId: 'a'.repeat(32) })
    const span = trace.span('synthesize')
    span.setOutput({ answer: 'The landlord must maintain the unit.' })
    span.end()

    // setOutput on a child span must update THAT span (not the trace).
    const childUpdate = calls.find(
      (c) => c.kind === 'update' && (c.args as { output?: unknown }).output != null,
    )
    expect(childUpdate?.args).toEqual({
      output: { answer: 'The landlord must maintain the unit.' },
    })
  })

  it('writes a child-span output through the SDK update call in nested mode', () => {
    const { client, calls } = fakeClient()
    const handle = createLangfuseTracer(env, client)
    const trace = handle.tracer.startTrace({
      name: 'owners-manual.naive-rag',
      traceId: 'a'.repeat(32),
      parentSpanId: 'b'.repeat(16),
    })
    const span = trace.span('synthesize')
    span.setOutput({ answer: 'The landlord must maintain the unit.' })
    span.end()

    // The child span lives under the service root span; its output is updated
    // on the child observation, not upserted onto the (harness-owned) trace.
    expect(calls.some((c) => c.kind === 'trace')).toBe(false)
    const childUpdate = calls.find(
      (c) => c.kind === 'update' && (c.args as { output?: unknown }).output != null,
    )
    expect(childUpdate?.args).toEqual({
      output: { answer: 'The landlord must maintain the unit.' },
    })
  })
})
