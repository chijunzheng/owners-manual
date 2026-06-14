import { describe, expect, it, vi } from 'vitest'

import { runAgent, type AgentTracer } from './agent-run.js'
import { REPAIR_CANDIDATE, scriptedModel } from './agent-fixtures.js'
import { type AgentRetrieve } from './agent-types.js'

const retrieve: AgentRetrieve = async () => [REPAIR_CANDIDATE]

/** A recording tracer fake that captures the span tree shape and trace id. */
function recordingTracer(): { tracer: AgentTracer; spans: string[]; traceId?: string } {
  const spans: string[] = []
  let traceId: string | undefined
  const tracer: AgentTracer = {
    startTrace: (opts) => {
      traceId = opts.traceId
      return {
        span: (name) => {
          spans.push(name)
          return { end: () => {} }
        },
        setOutput: () => {},
      }
    },
  }
  return {
    tracer,
    get traceId() {
      return traceId
    },
    spans,
  }
}

describe('runAgent', () => {
  it('returns a schema-valid answer envelope with the merged candidates', async () => {
    const result = await runAgent({
      question: 'who repairs the unit?',
      itemId: 'answer-repair-duty-condo',
      topK: 8,
      model: scriptedModel(),
      retrieve,
    })
    expect(result.envelope.behaviorClass).toBe('answer')
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.citablePathKey).toBe('rta-2006|part:III|section:20|subsection:1')
  })

  it('reports total latency and the raw model output', async () => {
    const result = await runAgent({
      question: 'q',
      itemId: 'x',
      topK: 8,
      model: scriptedModel(),
      retrieve,
    })
    expect(result.latencyMs.total).toBeGreaterThanOrEqual(0)
    expect(result.rawModelOutput).toContain('behaviorClass')
  })

  it('streams synthesis tokens to the onToken sink (the SSE feed)', async () => {
    const tokens: string[] = []
    await runAgent({
      question: 'q',
      itemId: 'x',
      topK: 8,
      model: scriptedModel({ streamChunks: 6 }),
      retrieve,
      onToken: (t) => tokens.push(t),
    })
    expect(tokens.length).toBeGreaterThan(1)
    expect(tokens.join('')).toContain('behaviorClass')
  })

  it('opens a trace under the propagated trace id with an agent-graph span', async () => {
    const recording = recordingTracer()
    await runAgent({
      question: 'q',
      itemId: 'x',
      traceId: 'deadbeefdeadbeefdeadbeefdeadbeef',
      topK: 8,
      model: scriptedModel(),
      retrieve,
      tracer: recording.tracer,
    })
    expect(recording.traceId).toBe('deadbeefdeadbeefdeadbeefdeadbeef')
    expect(recording.spans).toContain('agent-graph')
  })

  it('passes the harness parent span id into the tracer so service spans nest', async () => {
    let seenParent: string | undefined
    const tracer: AgentTracer = {
      startTrace: (opts) => {
        seenParent = opts.parentSpanId
        return { span: () => ({ end: () => {} }), setOutput: () => {} }
      },
    }
    await runAgent({
      question: 'q',
      itemId: 'x',
      traceId: 'c'.repeat(32),
      parentSpanId: 'f'.repeat(16),
      topK: 8,
      model: scriptedModel(),
      retrieve,
      tracer,
    })
    expect(seenParent).toBe('f'.repeat(16))
  })

  it('marks degraded when the Critic stays ungrounded at the cap', async () => {
    const ungrounded = {
      grounded: false,
      ungroundedClaims: ['The landlord must keep the unit in a good state of repair.'],
    }
    const result = await runAgent({
      question: 'who repairs the unit?',
      itemId: 'x',
      topK: 8,
      model: scriptedModel({ critiques: [ungrounded, ungrounded, ungrounded] }),
      retrieve,
    })
    expect(result.degraded).toBe(true)
  })

  it('still produces an answer when no tracer is supplied', async () => {
    const result = await runAgent({
      question: 'q',
      itemId: 'x',
      topK: 8,
      model: scriptedModel(),
      retrieve,
    })
    expect(result.envelope).toBeDefined()
  })

  it('ends the graph span it opens', async () => {
    const ends = vi.fn()
    const tracer: AgentTracer = {
      startTrace: () => ({ span: () => ({ end: ends }), setOutput: () => {} }),
    }
    await runAgent({
      question: 'q',
      itemId: 'x',
      topK: 8,
      model: scriptedModel(),
      retrieve,
      tracer,
    })
    expect(ends).toHaveBeenCalled()
  })

  it('refuses out-of-scope without retrieving when Guard blocks (jurisdiction)', async () => {
    const seen: string[] = []
    const spyRetrieve: AgentRetrieve = async (input) => {
      seen.push(input.question)
      return [REPAIR_CANDIDATE]
    }
    const result = await runAgent({
      question: 'can my BC landlord evict me?',
      itemId: 'x',
      topK: 8,
      model: scriptedModel({
        guard: {
          verdict: 'refuse-jurisdiction',
          injectionDetected: false,
          reason: 'BC, not Ontario',
        },
      }),
      retrieve: spyRetrieve,
    })
    expect(result.envelope.behaviorClass).toBe('refuse-jurisdiction')
    expect(seen).toEqual([])
  })
})
