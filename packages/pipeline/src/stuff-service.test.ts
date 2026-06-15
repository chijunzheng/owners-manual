import { describe, expect, it } from 'vitest'

import { type CorpusChunk } from './chunk-corpus.js'
import { buildRunRecord, type RunRecord } from './run-record.js'
import { NAIVE_RAG_PIPELINE_CONFIG } from './pipeline-config.js'
import {
  handleStuffRequest,
  parseStuffOracleRequest,
  parseStuffRequest,
  type StuffServiceDeps,
} from './stuff-service.js'
import { type StuffLlmComplete } from './stuff-synthesis.js'

const RUN_RECORD: RunRecord = buildRunRecord({
  config: NAIVE_RAG_PIPELINE_CONFIG,
  manifestSources: [{ id: 'rta-2006', sha256: 'a'.repeat(64), consolidationDate: '2024-01-01' }],
  fixtureSources: [{ id: 'fixture-lease', sha256: 'b'.repeat(64) }],
  includedDocumentIds: ['rta-2006', 'fixture-lease'],
})

const TENANCY_CHUNKS: CorpusChunk[] = [
  {
    id: 'rta-2006#0',
    citablePathKey: 'rta-2006|part:III|section:20|subsection:1',
    text: 'The landlord must keep the unit in a good state of repair.',
    documentId: 'rta-2006',
    chunker: 'hierarchy-v1',
  },
]

const GOVERNING_CHUNKS: CorpusChunk[] = [
  {
    id: 'fixture-declaration#0',
    citablePathKey: 'fixture-declaration|section:article-iii|subsection:pets|clause:p-1',
    text: 'Two household pets are permitted.',
    documentId: 'fixture-declaration',
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

function deps(overrides: Partial<StuffServiceDeps> = {}): StuffServiceDeps {
  return {
    complete: llm,
    runRecord: RUN_RECORD,
    chunksForArm: (arm, corpora) => {
      if (arm === 'stuff') return [...TENANCY_CHUNKS, ...GOVERNING_CHUNKS]
      // stuff-oracle: route by the oracle-supplied corpora.
      const out: CorpusChunk[] = []
      if (corpora?.includes('tenancy')) out.push(...TENANCY_CHUNKS)
      if (corpora?.includes('governing')) out.push(...GOVERNING_CHUNKS)
      return out
    },
    ...overrides,
  }
}

describe('parseStuffRequest', () => {
  it('accepts a minimal stuff request', () => {
    const req = parseStuffRequest({ question: 'q', itemId: 'x' })
    expect(req.question).toBe('q')
    expect(req.orderSeed).toBeUndefined()
  })

  it('accepts an order-probe seed', () => {
    expect(parseStuffRequest({ question: 'q', itemId: 'x', orderSeed: 3 }).orderSeed).toBe(3)
  })

  it('rejects a malformed trace id', () => {
    expect(() => parseStuffRequest({ question: 'q', itemId: 'x', traceId: 'nope' })).toThrow()
  })

  it('rejects unknown keys (strict)', () => {
    expect(() => parseStuffRequest({ question: 'q', itemId: 'x', corpora: ['tenancy'] })).toThrow()
  })
})

describe('parseStuffOracleRequest', () => {
  it('requires at least one routed corpus (the oracle decision)', () => {
    expect(() => parseStuffOracleRequest({ question: 'q', itemId: 'x', corpora: [] })).toThrow()
    expect(() => parseStuffOracleRequest({ question: 'q', itemId: 'x' })).toThrow()
  })

  it('accepts a routed-corpora set', () => {
    const req = parseStuffOracleRequest({ question: 'q', itemId: 'x', corpora: ['tenancy'] })
    expect(req.corpora).toEqual(['tenancy'])
  })

  it('rejects an unknown corpus tag', () => {
    expect(() =>
      parseStuffOracleRequest({ question: 'q', itemId: 'x', corpora: ['mystery'] }),
    ).toThrow()
  })
})

describe('handleStuffRequest', () => {
  it('stuffs the entire corpus for the stuff arm and emits the answer envelope', async () => {
    const response = await handleStuffRequest({ question: 'q', itemId: 'x' }, deps())
    expect(response.envelope.behaviorClass).toBe('answer')
    expect(response.arm).toBe('stuff')
    expect(response.stuffedSourceCount).toBe(2) // tenancy + governing
  })

  it('echoes the run record, candidate path keys, usage, cost, and order seed', async () => {
    const response = await handleStuffRequest({ question: 'q', itemId: 'x', orderSeed: 2 }, deps())
    expect(response.runRecord.corpusBuildHash).toBe(RUN_RECORD.corpusBuildHash)
    expect(response.retrievedCitablePathKeys).toContain('rta-2006|part:III|section:20|subsection:1')
    expect(response.usage.cachedPromptTokens).toBe(900)
    expect(response.costUsd).toBeGreaterThanOrEqual(0)
    expect(response.orderSeed).toBe(2)
  })

  it('routes stuff-oracle to ONLY the oracle-supplied corpora (fewer sources than stuff)', async () => {
    const response = await handleStuffRequest(
      { question: 'q', itemId: 'x', arm: 'stuff-oracle', corpora: ['tenancy'] },
      deps(),
    )
    expect(response.arm).toBe('stuff-oracle')
    expect(response.stuffedSourceCount).toBe(1) // tenancy only
    expect(response.retrievedCitablePathKeys).toEqual(['rta-2006|part:III|section:20|subsection:1'])
  })
})
