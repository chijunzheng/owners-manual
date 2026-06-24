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
import { type OwnerProfile, type ProfileStore } from './owner-profile.js'
import {
  SESSION_SUMMARY_MAX_CHARS,
  type SessionMemory,
  type SessionMemoryStore,
  type SessionSummarizer,
} from './session-memory.js'

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

/** An in-memory {@link ProfileStore} fake — no real personal data, no Mongo. */
function fakeProfileStore(seed: readonly OwnerProfile[] = []): ProfileStore {
  const byOwner = new Map(seed.map((p) => [p.ownerId, p]))
  return {
    load: async (ownerId) => byOwner.get(ownerId),
    save: async (profile) => {
      byOwner.set(profile.ownerId, profile)
    },
  }
}

/** An in-memory {@link SessionMemoryStore} fake, exposing its backing map. */
function fakeSessionStore(seed: readonly SessionMemory[] = []): SessionMemoryStore & {
  readonly saved: Map<string, SessionMemory>
} {
  const saved = new Map(seed.map((m) => [m.sessionId, m]))
  return {
    saved,
    load: async (sessionId) => saved.get(sessionId),
    save: async (memory) => {
      saved.set(memory.sessionId, memory)
    },
  }
}

/** A deterministic offline summarizer: appends the new turn, no network. */
const summarize: SessionSummarizer = async ({ priorSummary, question, answer }) =>
  `${priorSummary} [Q:${question} A:${answer}]`.trim()

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

  it('the result event carries the agent arm OWN retrieved chunk text for live RAGAS (#76)', async () => {
    // #76: the agent arm is RAGAS-scored on ITS OWN retrieval (bounded reformulation
    // + graph expansion + authority rerank), never a shared /retrieve/debug call —
    // so the terminal result must expose the retrieved chunk text, derived from the
    // SAME candidates retrievedCitablePathKeys is, aligned per-candidate.
    const events = await collect({ question: 'who repairs the unit?', itemId: 'answer-repair' })
    const result = events.find((e) => e.type === 'result')
    if (result?.type !== 'result') throw new Error('no result event')
    expect(result.retrievedContexts).toEqual([
      {
        citablePathKey: 'rta-2006|part:III|section:20|subsection:1',
        text: 'The landlord must keep the unit in a good state of repair.',
      },
    ])
    expect(result.retrievedContexts.map((c) => c.citablePathKey)).toEqual(
      result.retrievedCitablePathKeys,
    )
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
            return { span: () => ({ setOutput: () => {}, end: () => {} }), setOutput: () => {} }
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

describe('owner profile + session memory (#17)', () => {
  it('injects a stored owner profile into synthesis when the request carries an owner id', async () => {
    const model = scriptedModel()
    const profileStore = fakeProfileStore([
      { ownerId: 'owner-synthetic-001', facts: { unit: 'Unit 1203', building: 'YCC-42' } },
    ])
    await collect(
      { question: 'who repairs MY unit?', itemId: 'x', ownerId: 'owner-synthetic-001' },
      deps({ model, profileStore }),
    )
    expect(model.lastSynthesizeInput?.memory?.ownerProfile?.facts.unit).toBe('Unit 1203')
  })

  it('PROFILE FACTS SET IN SESSION A ARE USED IN SESSION B (AC1)', async () => {
    // One durable store shared across two independent requests (sessions).
    const profileStore = fakeProfileStore([
      {
        ownerId: 'owner-synthetic-001',
        facts: { unit: 'Unit 1203', policyNumber: 'POL-SYNTH-7788' },
      },
    ])

    // Session A: the owner asks something; the profile is loaded and injected.
    const modelA = scriptedModel()
    await collect(
      {
        question: 'who repairs the unit?',
        itemId: 'a',
        ownerId: 'owner-synthetic-001',
        sessionId: 'sess-A',
      },
      deps({ model: modelA, profileStore, sessionStore: fakeSessionStore(), summarize }),
    )
    expect(modelA.lastSynthesizeInput?.memory?.ownerProfile?.facts.unit).toBe('Unit 1203')

    // Session B: a DIFFERENT session id, same owner — the SAME facts are present
    // because the profile is cross-session (persisted in the store), proving AC1.
    const modelB = scriptedModel()
    await collect(
      {
        question: 'what is my deductible?',
        itemId: 'b',
        ownerId: 'owner-synthetic-001',
        sessionId: 'sess-B',
      },
      deps({ model: modelB, profileStore, sessionStore: fakeSessionStore(), summarize }),
    )
    expect(modelB.lastSynthesizeInput?.memory?.ownerProfile?.facts.unit).toBe('Unit 1203')
    expect(modelB.lastSynthesizeInput?.memory?.ownerProfile?.facts.policyNumber).toBe(
      'POL-SYNTH-7788',
    )
    // Session B sees the owner's facts but NOT session A's conversation summary
    // (session memory is per-session; the two mechanisms stay distinct).
    expect(modelB.lastSynthesizeInput?.memory?.sessionMemory?.summary ?? '').not.toContain(
      'who repairs the unit?',
    )
  })

  it('a profile WRITTEN during session A is loaded and used in a later session B (AC1, write→read)', async () => {
    // An initially EMPTY durable store, shared across both sessions.
    const profileStore = fakeProfileStore()

    // Session A "sets" the owner's facts (e.g. an onboarding write to the store).
    await profileStore.save({
      ownerId: 'owner-synthetic-001',
      facts: { unit: 'Unit 1203', building: 'YCC-42' },
    })

    // Session B (a separate request) loads what session A persisted.
    const modelB = scriptedModel()
    await collect(
      {
        question: 'what is my deductible?',
        itemId: 'b',
        ownerId: 'owner-synthetic-001',
        sessionId: 'sess-B',
      },
      deps({ model: modelB, profileStore }),
    )
    expect(modelB.lastSynthesizeInput?.memory?.ownerProfile?.facts.unit).toBe('Unit 1203')
    expect(modelB.lastSynthesizeInput?.memory?.ownerProfile?.facts.building).toBe('YCC-42')
  })

  it('loads the prior session summary and persists the updated bounded summary after the turn', async () => {
    const sessionStore = fakeSessionStore([
      { sessionId: 'sess-1', summary: 'Earlier asked about the master policy.', turnCount: 1 },
    ])
    const model = scriptedModel()
    await collect(
      { question: 'who repairs the unit?', itemId: 'x', sessionId: 'sess-1' },
      deps({ model, sessionStore, summarize }),
    )
    // The prior summary was injected into this turn's synthesis.
    expect(model.lastSynthesizeInput?.memory?.sessionMemory?.summary).toContain('master policy')
    // After the turn, the store holds an updated summary with a bumped turn count.
    const persisted = sessionStore.saved.get('sess-1')
    expect(persisted?.turnCount).toBe(2)
    expect(persisted?.summary).toContain('who repairs the unit?')
  })

  it('keeps the persisted session summary BOUNDED across many turns through the handler (AC2)', async () => {
    const sessionStore = fakeSessionStore()
    // A summarizer that, left unbounded, would append the full turn text forever.
    const growing: SessionSummarizer = async ({ priorSummary, question, answer }) =>
      `${priorSummary} ${question} ${answer}`
    for (let i = 0; i < 60; i += 1) {
      await collect(
        {
          question: `turn ${i}: a long question about the declaration, bylaws, and master policy`,
          itemId: 'x',
          sessionId: 'sess-long',
        },
        deps({ sessionStore, summarize: growing }),
      )
    }
    const persisted = sessionStore.saved.get('sess-long')
    expect(persisted?.turnCount).toBe(60)
    expect(persisted!.summary.length).toBeLessThanOrEqual(SESSION_SUMMARY_MAX_CHARS)
  })

  it('starts a fresh session summary when none is stored yet', async () => {
    const sessionStore = fakeSessionStore()
    await collect(
      { question: 'who repairs the unit?', itemId: 'x', sessionId: 'sess-new' },
      deps({ sessionStore, summarize }),
    )
    const persisted = sessionStore.saved.get('sess-new')
    expect(persisted?.turnCount).toBe(1)
  })

  it('persists the session even when no model answer is needed... but skips persistence on a Guard refusal', async () => {
    const sessionStore = fakeSessionStore()
    await collect(
      { question: 'can my BC landlord evict me?', itemId: 'x', sessionId: 'sess-refused' },
      deps({
        sessionStore,
        summarize,
        model: scriptedModel({
          guard: { verdict: 'refuse-jurisdiction', injectionDetected: false, reason: 'BC' },
        }),
      }),
    )
    // A refusal is not a substantive turn — nothing is folded into the summary.
    expect(sessionStore.saved.get('sess-refused')).toBeUndefined()
  })

  it('runs with neither mechanism when the request omits owner/session ids (the #15 baseline)', async () => {
    const model = scriptedModel()
    const events = await collect(
      { question: 'who repairs the unit?', itemId: 'x' },
      deps({ model }),
    )
    expect(model.lastSynthesizeInput?.memory).toBeUndefined()
    expect(events.at(-1)?.type).toBe('result')
  })

  it('still answers when an owner id is given but no profile store is wired', async () => {
    const events = await collect(
      { question: 'who repairs the unit?', itemId: 'x', ownerId: 'owner-synthetic-001' },
      deps(),
    )
    expect(events.find((e) => e.type === 'result')?.type).toBe('result')
  })

  it('rejects a malformed owner/session id shape but accepts well-formed ones', () => {
    expect(
      parseChatRequest({ question: 'q', itemId: 'x', ownerId: 'o', sessionId: 's' }).ownerId,
    ).toBe('o')
    expect(() => parseChatRequest({ question: 'q', itemId: 'x', ownerId: '' })).toThrow()
  })

  it('still emits the result when the summarizer fails — best-effort persistence must not mask a valid answer (Codex P2)', async () => {
    const failingSummarize: SessionSummarizer = async () => {
      throw new Error('summarizer unavailable')
    }
    const events = await collect(
      { question: 'who repairs the unit?', itemId: 'x', sessionId: 'sess-fail' },
      deps({ sessionStore: fakeSessionStore(), summarize: failingSummarize }),
    )
    // runAgent already streamed the answer and succeeded; a post-hoc persistence
    // failure must not turn the valid answer into an error event.
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'result')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('result')
  })

  it('still emits the result when the session store save fails (Codex P2)', async () => {
    const failingStore: SessionMemoryStore = {
      load: async () => undefined,
      save: async () => {
        throw new Error('mongo save failed')
      },
    }
    const events = await collect(
      { question: 'who repairs the unit?', itemId: 'x', sessionId: 'sess-save-fail' },
      deps({ sessionStore: failingStore, summarize }),
    )
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'result')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('result')
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
