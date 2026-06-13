import { describe, expect, it } from 'vitest'

import {
  NAIVE_RAG_PIPELINE_CONFIG,
  pipelineConfigSchema,
  pipelineConfigHash,
  type PipelineConfig,
} from './pipeline-config.js'

describe('NAIVE_RAG_PIPELINE_CONFIG', () => {
  it('is a schema-valid pipeline config', () => {
    expect(() => pipelineConfigSchema.parse(NAIVE_RAG_PIPELINE_CONFIG)).not.toThrow()
  })

  it('pins the naive-rag arm shape: fixed-size chunks, voyage-law-2, vector-only top-k', () => {
    expect(NAIVE_RAG_PIPELINE_CONFIG.arm).toBe('naive-rag')
    expect(NAIVE_RAG_PIPELINE_CONFIG.chunker).toBe('citable-unit')
    expect(NAIVE_RAG_PIPELINE_CONFIG.embedding.provider).toBe('voyage')
    expect(NAIVE_RAG_PIPELINE_CONFIG.embedding.model).toBe('voyage-law-2')
    expect(NAIVE_RAG_PIPELINE_CONFIG.embedding.dimensions).toBe(1024)
    expect(NAIVE_RAG_PIPELINE_CONFIG.retrieval.topK).toBeGreaterThan(0)
  })

  it('pins a stable flagship Gemini runtime model (no -preview)', () => {
    expect(NAIVE_RAG_PIPELINE_CONFIG.runtime.provider).toBe('vertex')
    expect(NAIVE_RAG_PIPELINE_CONFIG.runtime.model).toMatch(/^gemini-/)
    expect(NAIVE_RAG_PIPELINE_CONFIG.runtime.model).not.toMatch(/preview/)
  })
})

describe('pipelineConfigHash', () => {
  it('is a 64-char lowercase hex digest', () => {
    expect(pipelineConfigHash(NAIVE_RAG_PIPELINE_CONFIG)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable across calls (content-addressed)', () => {
    const a = pipelineConfigHash(NAIVE_RAG_PIPELINE_CONFIG)
    const b = pipelineConfigHash(NAIVE_RAG_PIPELINE_CONFIG)
    expect(a).toBe(b)
  })

  it('changes when any pinned field changes', () => {
    const base = pipelineConfigHash(NAIVE_RAG_PIPELINE_CONFIG)
    const swapped: PipelineConfig = {
      ...NAIVE_RAG_PIPELINE_CONFIG,
      embedding: { ...NAIVE_RAG_PIPELINE_CONFIG.embedding, model: 'gemini-embedding-001' },
    }
    expect(pipelineConfigHash(swapped)).not.toBe(base)
  })

  it('is independent of key order in the object literal', () => {
    const reordered = pipelineConfigSchema.parse({
      retrieval: NAIVE_RAG_PIPELINE_CONFIG.retrieval,
      runtime: NAIVE_RAG_PIPELINE_CONFIG.runtime,
      embedding: NAIVE_RAG_PIPELINE_CONFIG.embedding,
      chunker: NAIVE_RAG_PIPELINE_CONFIG.chunker,
      arm: NAIVE_RAG_PIPELINE_CONFIG.arm,
      indexName: NAIVE_RAG_PIPELINE_CONFIG.indexName,
      collection: NAIVE_RAG_PIPELINE_CONFIG.collection,
    })
    expect(pipelineConfigHash(reordered)).toBe(pipelineConfigHash(NAIVE_RAG_PIPELINE_CONFIG))
  })
})
