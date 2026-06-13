import { describe, expect, it, vi } from 'vitest'

import { type EmbeddingProvider } from './embedding.js'
import { runNaiveRag, type NaiveRagTracer } from './naive-rag.js'
import { type VectorSearchExecutor } from './retrieve.js'
import { type LlmComplete } from './synthesize.js'

const provider: EmbeddingProvider = {
  model: 'voyage-law-2',
  dimensions: 4,
  embedDocuments: async (t) => t.map(() => [0, 0, 0, 0]),
  embedQuery: async () => [0.1, 0.2, 0.3, 0.4],
}

const search: VectorSearchExecutor = async ({ topK }) =>
  [
    {
      documentId: 'rta-2006',
      citablePathKey: 'rta-2006|part:III|section:20|subsection:1',
      text: 'The landlord maintains the unit.',
      score: 0.9,
    },
  ].slice(0, topK)

const llm: LlmComplete = async () =>
  JSON.stringify({
    behaviorClass: 'answer',
    answer: 'The landlord must maintain the unit.',
    claims: [
      {
        text: 'The landlord must maintain the unit.',
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
  })

/** A recording tracer fake that captures the span tree shape. */
function recordingTracer(): { tracer: NaiveRagTracer; spans: string[]; traceId?: string } {
  const spans: string[] = []
  let traceId: string | undefined
  const tracer: NaiveRagTracer = {
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

describe('runNaiveRag', () => {
  it('returns a schema-valid envelope plus the retrieved candidates', async () => {
    const result = await runNaiveRag({
      question: 'who repairs the unit?',
      itemId: 'answer-repair-duty-condo',
      topK: 8,
      provider,
      search,
      complete: llm,
    })
    expect(result.envelope.behaviorClass).toBe('answer')
    expect(result.candidates).toHaveLength(1)
  })

  it('reports retrieval and synthesis latency and the model output', async () => {
    const result = await runNaiveRag({
      question: 'q',
      itemId: 'x',
      topK: 8,
      provider,
      search,
      complete: llm,
    })
    expect(result.latencyMs.total).toBeGreaterThanOrEqual(0)
    expect(result.latencyMs.retrieval).toBeGreaterThanOrEqual(0)
    expect(result.latencyMs.synthesis).toBeGreaterThanOrEqual(0)
    expect(result.rawModelOutput).toContain('behaviorClass')
  })

  it('opens a trace under the supplied (propagated) trace id with retrieve + synthesize spans', async () => {
    const recording = recordingTracer()
    await runNaiveRag({
      question: 'q',
      itemId: 'x',
      traceId: 'deadbeefdeadbeefdeadbeefdeadbeef',
      topK: 8,
      provider,
      search,
      complete: llm,
      tracer: recording.tracer,
    })
    expect(recording.traceId).toBe('deadbeefdeadbeefdeadbeefdeadbeef')
    expect(recording.spans).toContain('retrieve')
    expect(recording.spans).toContain('synthesize')
  })

  it('still produces an answer when no tracer is supplied', async () => {
    const result = await runNaiveRag({
      question: 'q',
      itemId: 'x',
      topK: 8,
      provider,
      search,
      complete: llm,
    })
    expect(result.envelope).toBeDefined()
  })

  it('records every candidate path key for the harness hit-rate metric', async () => {
    const result = await runNaiveRag({
      question: 'q',
      itemId: 'x',
      topK: 8,
      provider,
      search,
      complete: llm,
    })
    expect(result.candidates.map((c) => c.citablePathKey)).toEqual([
      'rta-2006|part:III|section:20|subsection:1',
    ])
  })

  it('propagates a synthesis failure rather than emitting an invalid envelope', async () => {
    const broken: LlmComplete = async () => 'not json'
    await expect(
      runNaiveRag({ question: 'q', itemId: 'x', topK: 8, provider, search, complete: broken }),
    ).rejects.toThrow(/JSON/i)
  })

  it('ends every span it opens even on the happy path', async () => {
    const ends = vi.fn()
    const tracer: NaiveRagTracer = {
      startTrace: () => ({ span: () => ({ end: ends }), setOutput: () => {} }),
    }
    await runNaiveRag({
      question: 'q',
      itemId: 'x',
      topK: 8,
      provider,
      search,
      complete: llm,
      tracer,
    })
    expect(ends).toHaveBeenCalledTimes(2)
  })
})
