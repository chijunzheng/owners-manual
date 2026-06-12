import { describe, expect, it } from 'vitest'

import { type EmbeddingProvider } from './embedding.js'
import { NAIVE_RAG_PIPELINE_CONFIG } from './pipeline-config.js'
import { type VectorSearchExecutor } from './retrieve.js'
import { buildRunRecord } from './run-record.js'
import { handleAnswerRequest, parseAnswerRequest } from './service.js'
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
})
