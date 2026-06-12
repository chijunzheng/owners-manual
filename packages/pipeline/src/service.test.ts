import { describe, expect, it } from 'vitest'

import { type EmbeddingProvider } from './embedding.js'
import { NAIVE_RAG_PIPELINE_CONFIG } from './pipeline-config.js'
import { type VectorSearchExecutor } from './retrieve.js'
import { buildRunRecord } from './run-record.js'
import { handleAnswerRequest, parseAnswerRequest, resolveTraceContext } from './service.js'
import { type LlmComplete } from './synthesize.js'

const provider: EmbeddingProvider = {
  model: 'voyage-law-2',
  dimensions: 4,
  embedDocuments: async (t) => t.map(() => [0, 0, 0, 0]),
  embedQuery: async () => [0.1, 0.2, 0.3, 0.4],
}

const search: VectorSearchExecutor = async () => [
  {
    documentId: 'rta-2006',
    citablePathKey: 'rta-2006|part:III|section:20|subsection:1',
    text: 'The landlord maintains the unit.',
    score: 0.9,
  },
]

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

const runRecord = buildRunRecord({
  config: NAIVE_RAG_PIPELINE_CONFIG,
  manifestSources: [{ id: 'rta-2006', sha256: 'a'.repeat(64), consolidationDate: '2025-11-27' }],
  fixtureSources: [{ id: 'fixture-lease', sha256: 'd'.repeat(64) }],
  includedDocumentIds: ['rta-2006'],
})

function deps() {
  return { provider, search, complete: llm, runRecord, topK: 8 }
}

describe('parseAnswerRequest', () => {
  it('accepts a well-formed request', () => {
    const req = parseAnswerRequest({ question: 'q', itemId: 'x', traceId: 'a'.repeat(32) })
    expect(req.question).toBe('q')
    expect(req.traceId).toBe('a'.repeat(32))
  })

  it('makes traceId optional', () => {
    const req = parseAnswerRequest({ question: 'q', itemId: 'x' })
    expect(req.traceId).toBeUndefined()
  })

  it('rejects a request with no question', () => {
    expect(() => parseAnswerRequest({ itemId: 'x' })).toThrow()
  })

  it('rejects a malformed trace id (must be 32 hex chars)', () => {
    expect(() => parseAnswerRequest({ question: 'q', itemId: 'x', traceId: 'nope' })).toThrow()
  })
})

describe('handleAnswerRequest', () => {
  it('returns a schema-valid envelope plus candidates, run record, and latency', async () => {
    const response = await handleAnswerRequest(
      { question: 'who repairs the unit?', itemId: 'answer-repair', traceId: 'a'.repeat(32) },
      deps(),
    )
    expect(response.envelope.behaviorClass).toBe('answer')
    expect(response.retrievedCitablePathKeys).toEqual(['rta-2006|part:III|section:20|subsection:1'])
    expect(response.runRecord.corpusBuildHash).toBe(runRecord.corpusBuildHash)
    expect(response.latencyMs.total).toBeGreaterThanOrEqual(0)
  })

  it('echoes the propagated trace id so the harness can correlate', async () => {
    const response = await handleAnswerRequest(
      { question: 'q', itemId: 'x', traceId: 'b'.repeat(32) },
      deps(),
    )
    expect(response.traceId).toBe('b'.repeat(32))
  })

  it('passes the propagated trace id into the tracer', async () => {
    let seen: string | undefined
    await handleAnswerRequest(
      { question: 'q', itemId: 'x', traceId: 'c'.repeat(32) },
      {
        ...deps(),
        tracer: {
          startTrace: (opts) => {
            seen = opts.traceId
            return { span: () => ({ end: () => {} }), setOutput: () => {} }
          },
        },
      },
    )
    expect(seen).toBe('c'.repeat(32))
  })

  it('passes the harness parent span id into the tracer so service spans nest (AC2)', async () => {
    let seenParent: string | undefined
    await handleAnswerRequest(
      { question: 'q', itemId: 'x', traceId: 'c'.repeat(32), parentSpanId: 'f'.repeat(16) },
      {
        ...deps(),
        tracer: {
          startTrace: (opts) => {
            seenParent = opts.parentSpanId
            return { span: () => ({ end: () => {} }), setOutput: () => {} }
          },
        },
      },
    )
    expect(seenParent).toBe('f'.repeat(16))
  })
})

describe('resolveTraceContext', () => {
  const traceId = 'a'.repeat(32)
  const spanId = 'b'.repeat(16)
  const header = `00-${traceId}-${spanId}-01`

  it('extracts the parent span id from a valid traceparent matching the body trace id', () => {
    expect(resolveTraceContext(traceId, header)).toEqual({ traceId, parentSpanId: spanId })
  })

  it('adopts the header trace id when the body carries none', () => {
    expect(resolveTraceContext(undefined, header)).toEqual({ traceId, parentSpanId: spanId })
  })

  it('ignores the header entirely when its trace id contradicts the body', () => {
    const other = 'c'.repeat(32)
    expect(resolveTraceContext(other, header)).toEqual({ traceId: other })
  })

  it.each([
    ['garbage', 'not-a-traceparent'],
    ['uppercase hex', `00-${'A'.repeat(32)}-${spanId}-01`],
    ['short trace id', `00-${'a'.repeat(31)}-${spanId}-01`],
    ['short span id', `00-${traceId}-${'b'.repeat(15)}-01`],
    ['missing flags', `00-${traceId}-${spanId}`],
  ])('rejects a malformed traceparent (%s) and falls back to the body', (_label, bad) => {
    expect(resolveTraceContext(traceId, bad)).toEqual({ traceId })
  })

  it('uses the first value when the header arrives as an array', () => {
    expect(resolveTraceContext(traceId, [header, 'other'])).toEqual({
      traceId,
      parentSpanId: spanId,
    })
  })

  it('returns only the body trace id when no header is present', () => {
    expect(resolveTraceContext(traceId, undefined)).toEqual({ traceId })
  })
})
