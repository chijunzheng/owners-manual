import { describe, expect, it } from 'vitest'

import { NAIVE_RAG_PIPELINE_CONFIG } from './pipeline-config.js'
import { buildRunRecord, runRecordSchema, type ManifestSnapshotSource } from './run-record.js'

const manifestSources: ManifestSnapshotSource[] = [
  { id: 'rta-2006', sha256: 'a'.repeat(64), consolidationDate: '2025-11-27' },
  { id: 'reg-516-06', sha256: 'b'.repeat(64), consolidationDate: '2020-11-30' },
]

describe('buildRunRecord', () => {
  it('records the pipeline-config snapshot and its content hash', () => {
    const record = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources,
      includedDocumentIds: ['rta-2006', 'reg-516-06', 'fixture-lease', 'fixture-declaration'],
    })
    expect(record.pipelineConfig).toEqual(NAIVE_RAG_PIPELINE_CONFIG)
    expect(record.pipelineConfigHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('records exactly the manifest sources it measured, with checksums', () => {
    const record = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources,
      includedDocumentIds: ['rta-2006', 'reg-516-06'],
    })
    expect(record.manifest.sources).toHaveLength(2)
    expect(record.manifest.sources[0]?.sha256).toHaveLength(64)
  })

  it('validates against the run-record schema', () => {
    const record = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources,
      includedDocumentIds: ['rta-2006'],
    })
    expect(() => runRecordSchema.parse(record)).not.toThrow()
  })

  it('derives a corpus-build hash from manifest + pipeline config (ADR 0004)', () => {
    const base = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources,
      includedDocumentIds: ['rta-2006'],
    })
    const driftedManifest = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources: [{ ...manifestSources[0]!, sha256: 'c'.repeat(64) }, manifestSources[1]!],
      includedDocumentIds: ['rta-2006'],
    })
    expect(base.corpusBuildHash).not.toBe(driftedManifest.corpusBuildHash)
  })

  it('excludes the checksum-failing rent-increase-guideline source by construction', () => {
    const record = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources,
      includedDocumentIds: ['rta-2006', 'reg-516-06'],
    })
    expect(record.manifest.sources.map((s) => s.id)).not.toContain('rent-increase-guideline')
  })
})
