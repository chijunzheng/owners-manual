import { describe, expect, it, vi } from 'vitest'

import { type CorpusChunk } from './chunk-corpus.js'
import { runStuff, type StuffTracer } from './stuff.js'
import { type StuffLlmComplete } from './stuff-synthesis.js'
import { type NaiveRagTracer } from './naive-rag.js'

const chunks: CorpusChunk[] = [
  {
    id: 'rta-2006#0',
    citablePathKey: 'rta-2006|part:III|section:20|subsection:1',
    text: 'The landlord must keep the unit in a good state of repair.',
    documentId: 'rta-2006',
    chunker: 'hierarchy-v1',
  },
  {
    id: 'fixture-lease#0',
    citablePathKey: 'fixture-lease|section:pets|clause:p-1',
    text: 'No pets of any kind are permitted.',
    documentId: 'fixture-lease',
    chunker: 'hierarchy-v1',
  },
]

const llm: StuffLlmComplete = async () => ({
  text: JSON.stringify({
    behaviorClass: 'answer',
    answer: 'The landlord must keep the unit in repair.',
    claims: [
      {
        text: 'The landlord must keep the unit in repair.',
        cites: [
          {
            documentId: 'rta-2006',
            segments: [
              { kind: 'part', label: 'III' },
              { kind: 'section', label: '20' },
              { kind: 'subsection', label: '1' },
            ],
          },
        ],
      },
    ],
  }),
  usage: { promptTokens: 1000, cachedPromptTokens: 900, completionTokens: 50 },
})

/**
 * A recording tracer fake that captures the trace id, arm, span names, the
 * per-span outputs (keyed by span name), and the trace-level output — so tests
 * can pin full-envelope-on-trace and answer-on-synthesize-span.
 */
function recordingTracer(): {
  tracer: StuffTracer
  spans: string[]
  spanOutputs: Record<string, unknown>
  traceOutput?: unknown
  traceId?: string
  arm?: unknown
} {
  const spans: string[] = []
  const spanOutputs: Record<string, unknown> = {}
  let traceOutput: unknown
  let traceId: string | undefined
  let arm: unknown
  const tracer: NaiveRagTracer = {
    startTrace: (opts) => {
      traceId = opts.traceId
      arm = opts.metadata?.arm
      return {
        span: (name) => {
          spans.push(name)
          return {
            setOutput: (output) => {
              spanOutputs[name] = output
            },
            end: () => {},
          }
        },
        setOutput: (output) => {
          traceOutput = output
        },
      }
    },
  }
  return {
    tracer,
    get traceId() {
      return traceId
    },
    get traceOutput() {
      return traceOutput
    },
    get arm() {
      return arm
    },
    spanOutputs,
    spans,
  }
}

describe('runStuff', () => {
  it('stuffs every chunk and returns a schema-valid envelope plus the candidates', async () => {
    const result = await runStuff({
      question: 'who repairs the unit?',
      itemId: 'answer-repair-duty-condo',
      arm: 'stuff',
      chunks,
      complete: llm,
    })
    expect(result.envelope.behaviorClass).toBe('answer')
    expect(result.candidates).toHaveLength(2)
    expect(result.stuffedSourceCount).toBe(2)
  })

  it('records token usage and a non-negative cost (honest cost-per-question)', async () => {
    const result = await runStuff({
      question: 'q',
      itemId: 'x',
      arm: 'stuff',
      chunks,
      complete: llm,
    })
    expect(result.usage.promptTokens).toBe(1000)
    expect(result.usage.cachedPromptTokens).toBe(900)
    expect(result.costUsd).toBeGreaterThanOrEqual(0)
  })

  it('reports which order seed it stuffed in (0 = canonical baseline)', async () => {
    const baseline = await runStuff({
      question: 'q',
      itemId: 'x',
      arm: 'stuff',
      chunks,
      complete: llm,
    })
    expect(baseline.orderSeed).toBe(0)
    const probed = await runStuff({
      question: 'q',
      itemId: 'x',
      arm: 'stuff',
      chunks,
      complete: llm,
      orderSeed: 3,
    })
    expect(probed.orderSeed).toBe(3)
  })

  it('opens a trace under the propagated trace id, tagged with the arm', async () => {
    const recording = recordingTracer()
    await runStuff({
      question: 'q',
      itemId: 'x',
      arm: 'stuff-oracle',
      chunks,
      complete: llm,
      traceId: 'deadbeefdeadbeefdeadbeefdeadbeef',
      tracer: recording.tracer,
    })
    expect(recording.traceId).toBe('deadbeefdeadbeefdeadbeefdeadbeef')
    expect(recording.arm).toBe('stuff-oracle')
    expect(recording.spans).toContain('synthesize')
  })

  it('does NOT open a retrieve span — a stuffed arm performs no retrieval', async () => {
    const recording = recordingTracer()
    await runStuff({
      question: 'q',
      itemId: 'x',
      arm: 'stuff',
      chunks,
      complete: llm,
      tracer: recording.tracer,
    })
    expect(recording.spans).not.toContain('retrieve')
  })

  it('reports synthesis and total latency and the raw model output', async () => {
    const result = await runStuff({
      question: 'q',
      itemId: 'x',
      arm: 'stuff',
      chunks,
      complete: llm,
    })
    expect(result.latencyMs.total).toBeGreaterThanOrEqual(0)
    expect(result.latencyMs.synthesis).toBeGreaterThanOrEqual(0)
    expect(result.rawModelOutput).toContain('behaviorClass')
  })

  it('propagates a synthesis failure rather than emitting an invalid envelope', async () => {
    const broken: StuffLlmComplete = async () => ({
      text: 'not json',
      usage: { promptTokens: 1, cachedPromptTokens: 0, completionTokens: 1 },
    })
    await expect(
      runStuff({ question: 'q', itemId: 'x', arm: 'stuff', chunks, complete: broken }),
    ).rejects.toThrow(/JSON/i)
  })

  it('ends every span it opens even on the happy path', async () => {
    const ends = vi.fn()
    const tracer: StuffTracer = {
      startTrace: () => ({
        span: () => ({ setOutput: () => {}, end: ends }),
        setOutput: () => {},
      }),
    }
    await runStuff({ question: 'q', itemId: 'x', arm: 'stuff', chunks, complete: llm, tracer })
    expect(ends).toHaveBeenCalled()
  })

  it('sets the trace output to the full envelope plus stuffedSourceCount', async () => {
    const recording = recordingTracer()
    const result = await runStuff({
      question: 'who repairs the unit?',
      itemId: 'answer-repair-duty-condo',
      arm: 'stuff',
      chunks,
      complete: llm,
      tracer: recording.tracer,
    })
    expect(recording.traceOutput).toEqual({
      behaviorClass: 'answer',
      answer: result.envelope.answer,
      claims: result.envelope.claims,
      stuffedSourceCount: result.candidates.length,
    })
  })

  it('records the answer prose on the synthesize span output', async () => {
    const recording = recordingTracer()
    const result = await runStuff({
      question: 'who repairs the unit?',
      itemId: 'answer-repair-duty-condo',
      arm: 'stuff',
      chunks,
      complete: llm,
      tracer: recording.tracer,
    })
    expect(recording.spanOutputs.synthesize).toEqual({ answer: result.envelope.answer })
  })

  it('throws when given no chunks to stuff (a build bug, not an empty answer)', async () => {
    await expect(
      runStuff({ question: 'q', itemId: 'x', arm: 'stuff', chunks: [], complete: llm }),
    ).rejects.toThrow(/no.*chunks|empty/i)
  })
})
