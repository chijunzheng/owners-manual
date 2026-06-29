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
import { type StuffArm } from './stuff.js'
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

  it('carries NO retrievedContexts: the stuff arms are not RAG arms, so they get no RAGAS columns (#76)', async () => {
    // #76 wires retrieved chunk text onto the RAG arms ONLY (naive-rag, agent). The
    // stuffing arms have no retrieval to score, so their envelope is unchanged — the
    // four-arm dashboard leaves their RAGAS columns blank, never blended.
    const response = await handleStuffRequest({ question: 'q', itemId: 'x' }, deps())
    expect('retrievedContexts' in response).toBe(false)
  })

  // The #44 context-cache binding gives canonical-order `stuff` a cached completion
  // (suffix-only send) but keeps `stuff-oracle` UNCACHED (its routed subset is not
  // the cached prefix). The handler selects the completion through `completeForArm`
  // by arm AND order seed; absent it, the single `complete` serves both arms.
  it('selects the completion via completeForArm by arm and order seed when wired', async () => {
    const seen: Array<[StuffArm, number]> = []
    const completeForArm = (arm: StuffArm, orderSeed: number): StuffLlmComplete => {
      return async () => {
        seen.push([arm, orderSeed])
        return llm('')
      }
    }
    await handleStuffRequest({ question: 'q', itemId: 'x' }, deps({ completeForArm }))
    await handleStuffRequest(
      { question: 'q', itemId: 'x', arm: 'stuff-oracle', corpora: ['tenancy'] },
      deps({ completeForArm }),
    )
    expect(seen).toEqual([
      ['stuff', 0],
      ['stuff-oracle', 0],
    ])
  })

  // Regression (Codex P2 on #44): the order-permutation probe (orderSeed > 0) builds
  // the prompt over PERMUTED chunks, so it is NOT the cached canonical prefix. The
  // handler must hand the probe its order seed so the binding can route it AROUND the
  // cache; routing it to the prefix-stripping cached completion would throw on the
  // non-canonical prompt instead of running the probe.
  it('forwards the order seed to completeForArm so a probe (orderSeed > 0) can bypass the cache', async () => {
    const seen: Array<[StuffArm, number]> = []
    const completeForArm = (arm: StuffArm, orderSeed: number): StuffLlmComplete => {
      return async () => {
        seen.push([arm, orderSeed])
        return llm('')
      }
    }
    await handleStuffRequest({ question: 'q', itemId: 'x', orderSeed: 3 }, deps({ completeForArm }))
    expect(seen).toEqual([['stuff', 3]])
  })

  it('falls back to the single complete when completeForArm is not wired', async () => {
    let calls = 0
    const complete: StuffLlmComplete = async (prompt) => {
      calls += 1
      return llm(prompt)
    }
    await handleStuffRequest({ question: 'q', itemId: 'x' }, deps({ complete }))
    expect(calls).toBe(1)
  })
})
