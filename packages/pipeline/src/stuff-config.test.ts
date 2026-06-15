import { describe, expect, it } from 'vitest'

import {
  STUFF_RUNTIME_CONFIG,
  stuffRuntimeConfigSchema,
  buildChunksForArm,
} from './stuff-config.js'
import { NAIVE_RAG_PIPELINE_CONFIG } from './pipeline-config.js'
import { type CorpusChunk } from './chunk-corpus.js'

describe('STUFF_RUNTIME_CONFIG', () => {
  it('validates against its schema', () => {
    expect(() => stuffRuntimeConfigSchema.parse(STUFF_RUNTIME_CONFIG)).not.toThrow()
  })

  it('runs the SAME product model as naive-rag (arm gaps measure architecture)', () => {
    expect(STUFF_RUNTIME_CONFIG.model).toBe(NAIVE_RAG_PIPELINE_CONFIG.runtime.model)
  })

  it('enables Vertex context caching for the fixed corpus prefix', () => {
    expect(STUFF_RUNTIME_CONFIG.contextCaching).toBe(true)
  })

  it('pins non-negative per-million-token rates (cached input no costlier than uncached)', () => {
    expect(STUFF_RUNTIME_CONFIG.costRates.inputPerMTok).toBeGreaterThanOrEqual(0)
    expect(STUFF_RUNTIME_CONFIG.costRates.cachedInputPerMTok).toBeGreaterThanOrEqual(0)
    expect(STUFF_RUNTIME_CONFIG.costRates.outputPerMTok).toBeGreaterThanOrEqual(0)
    expect(STUFF_RUNTIME_CONFIG.costRates.cachedInputPerMTok).toBeLessThanOrEqual(
      STUFF_RUNTIME_CONFIG.costRates.inputPerMTok,
    )
  })
})

describe('buildChunksForArm', () => {
  const tenancy: CorpusChunk = {
    id: 'rta#0',
    citablePathKey: 'rta-2006|section:20',
    text: 'repair duty',
    documentId: 'rta-2006',
    chunker: 'hierarchy-v1',
  }
  const governing: CorpusChunk = {
    id: 'decl#0',
    citablePathKey: 'fixture-declaration|section:pets',
    text: 'pets',
    documentId: 'fixture-declaration',
    chunker: 'hierarchy-v1',
  }
  // documentId → corpus and documentId → its chunks (built once by the CLI).
  const corpusOf = (id: string): string => (id === 'fixture-declaration' ? 'governing' : 'tenancy')
  const byDocument = new Map([
    ['rta-2006', [tenancy]],
    ['fixture-declaration', [governing]],
  ])
  const resolve = buildChunksForArm({
    documentIds: ['rta-2006', 'fixture-declaration'],
    chunksByDocument: byDocument,
    corpusOfDocument: corpusOf,
  })

  it('stuffs every document for the stuff arm in canonical order', () => {
    expect(resolve('stuff').map((c) => c.id)).toEqual(['rta#0', 'decl#0'])
  })

  it('routes stuff-oracle to only the requested corpora', () => {
    expect(resolve('stuff-oracle', ['governing']).map((c) => c.id)).toEqual(['decl#0'])
    expect(resolve('stuff-oracle', ['tenancy']).map((c) => c.id)).toEqual(['rta#0'])
  })

  it('routes a multi-corpus oracle set in canonical document order', () => {
    expect(resolve('stuff-oracle', ['governing', 'tenancy']).map((c) => c.id)).toEqual([
      'rta#0',
      'decl#0',
    ])
  })
})
