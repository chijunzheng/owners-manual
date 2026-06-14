import { describe, expect, it } from 'vitest'

import {
  formatSseEvent,
  handleChatRequest,
  parseChatRequest,
  type ChatEvent,
  type ChatServiceDeps,
} from './chat-service.js'
import { REPAIR_CANDIDATE, scriptedModel } from './agent-fixtures.js'
import { type AgentRetrieve } from './agent-types.js'
import { NAIVE_RAG_PIPELINE_CONFIG } from './pipeline-config.js'
import { buildRunRecord } from './run-record.js'

const retrieve: AgentRetrieve = async () => [REPAIR_CANDIDATE]

const runRecord = buildRunRecord({
  config: NAIVE_RAG_PIPELINE_CONFIG,
  manifestSources: [{ id: 'rta-2006', sha256: 'a'.repeat(64), consolidationDate: '2025-11-27' }],
  fixtureSources: [{ id: 'fixture-lease', sha256: 'd'.repeat(64) }],
  includedDocumentIds: ['rta-2006'],
})

function deps(overrides: Partial<ChatServiceDeps> = {}): ChatServiceDeps {
  return { model: scriptedModel(), retrieve, runRecord, topK: 8, ...overrides }
}

/** Drive the handler and collect every emitted SSE event. */
async function collect(
  request: Parameters<typeof handleChatRequest>[0],
  d: ChatServiceDeps = deps(),
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  await handleChatRequest(request, d, (e) => events.push(e))
  return events
}

describe('parseChatRequest', () => {
  it('accepts a well-formed request', () => {
    const req = parseChatRequest({ question: 'q', itemId: 'x', traceId: 'a'.repeat(32) })
    expect(req.question).toBe('q')
  })

  it('makes traceId optional', () => {
    expect(parseChatRequest({ question: 'q', itemId: 'x' }).traceId).toBeUndefined()
  })

  it('rejects an empty question', () => {
    expect(() => parseChatRequest({ question: '', itemId: 'x' })).toThrow()
  })

  it('rejects a malformed trace id', () => {
    expect(() => parseChatRequest({ question: 'q', itemId: 'x', traceId: 'nope' })).toThrow()
  })

  it('rejects an unknown extra field (strict)', () => {
    expect(() => parseChatRequest({ question: 'q', itemId: 'x', extra: 1 })).toThrow()
  })
})

describe('handleChatRequest — streaming', () => {
  it('streams token events then exactly one terminal result event (AC1)', async () => {
    const events = await collect(
      { question: 'who repairs the unit?', itemId: 'answer-repair' },
      deps({ model: scriptedModel({ streamChunks: 5 }) }),
    )
    const tokens = events.filter((e) => e.type === 'token')
    const results = events.filter((e) => e.type === 'result')
    expect(tokens.length).toBeGreaterThan(1)
    expect(results).toHaveLength(1)
    // Every token precedes the terminal result.
    expect(events.at(-1)?.type).toBe('result')
  })

  it('the result event carries a schema-valid answer envelope with pin-cites', async () => {
    const events = await collect({ question: 'who repairs the unit?', itemId: 'answer-repair' })
    const result = events.find((e) => e.type === 'result')
    expect(result?.type).toBe('result')
    if (result?.type !== 'result') throw new Error('no result event')
    expect(result.envelope.behaviorClass).toBe('answer')
    expect(result.envelope.claims[0]!.cites[0]!.documentId).toBe('rta-2006')
    expect(result.retrievedCitablePathKeys).toContain('rta-2006|part:III|section:20|subsection:1')
  })

  it('echoes the propagated trace id on the result event', async () => {
    const events = await collect({ question: 'q', itemId: 'x', traceId: 'b'.repeat(32) })
    const result = events.find((e) => e.type === 'result')
    if (result?.type !== 'result') throw new Error('no result event')
    expect(result.traceId).toBe('b'.repeat(32))
  })

  it('includes the run record so the harness pins the build', async () => {
    const events = await collect({ question: 'q', itemId: 'x' })
    const result = events.find((e) => e.type === 'result')
    if (result?.type !== 'result') throw new Error('no result event')
    expect(result.runRecord.corpusBuildHash).toBe(runRecord.corpusBuildHash)
  })

  it('passes the propagated trace id and parent span into the tracer (AC2)', async () => {
    let seenTrace: string | undefined
    let seenParent: string | undefined
    await collect(
      { question: 'q', itemId: 'x', traceId: 'c'.repeat(32), parentSpanId: 'f'.repeat(16) },
      deps({
        tracer: {
          startTrace: (opts) => {
            seenTrace = opts.traceId
            seenParent = opts.parentSpanId
            return { span: () => ({ end: () => {} }), setOutput: () => {} }
          },
        },
      }),
    )
    expect(seenTrace).toBe('c'.repeat(32))
    expect(seenParent).toBe('f'.repeat(16))
  })

  it('reaches a refusal behavior class with no tokens streamed (Guard short-circuit)', async () => {
    const events = await collect(
      { question: 'can my BC landlord evict me?', itemId: 'x' },
      deps({
        model: scriptedModel({
          guard: { verdict: 'refuse-jurisdiction', injectionDetected: false, reason: 'BC' },
        }),
      }),
    )
    const tokens = events.filter((e) => e.type === 'token')
    const result = events.find((e) => e.type === 'result')
    expect(tokens).toHaveLength(0)
    if (result?.type !== 'result') throw new Error('no result event')
    expect(result.envelope.behaviorClass).toBe('refuse-jurisdiction')
  })

  it('reports a degraded result honestly on the result event', async () => {
    const ungrounded = {
      grounded: false,
      ungroundedClaims: ['The landlord must keep the unit in a good state of repair.'],
    }
    const events = await collect(
      { question: 'who repairs the unit?', itemId: 'x' },
      deps({ model: scriptedModel({ critiques: [ungrounded, ungrounded, ungrounded] }) }),
    )
    const result = events.find((e) => e.type === 'result')
    if (result?.type !== 'result') throw new Error('no result event')
    expect(result.degraded).toBe(true)
  })

  it('emits a single error event when the model returns invalid JSON (never throws across SSE)', async () => {
    const events = await collect(
      { question: 'q', itemId: 'x' },
      deps({ model: scriptedModel({ synthesisOutputs: ['not json'] }) }),
    )
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    if (errors[0]?.type !== 'error') throw new Error('no error event')
    expect(errors[0].message).toMatch(/JSON/i)
  })
})

describe('formatSseEvent', () => {
  it('frames a token event as SSE wire format', () => {
    const frame = formatSseEvent({ type: 'token', token: 'hello' })
    expect(frame).toBe('event: token\ndata: {"type":"token","token":"hello"}\n\n')
  })

  it('frames a result event with a trailing blank line', () => {
    const frame = formatSseEvent({ type: 'error', message: 'boom' })
    expect(frame.endsWith('\n\n')).toBe(true)
    expect(frame.startsWith('event: error\n')).toBe(true)
  })
})
