import { describe, expect, it } from 'vitest'

import { NAIVE_RAG_PIPELINE_CONFIG } from './pipeline-config.js'
import {
  buildRunRecord,
  runRecordSchema,
  type FixtureSnapshotSource,
  type ManifestSnapshotSource,
} from './run-record.js'

const manifestSources: ManifestSnapshotSource[] = [
  { id: 'rta-2006', sha256: 'a'.repeat(64), consolidationDate: '2025-11-27' },
  { id: 'reg-516-06', sha256: 'b'.repeat(64), consolidationDate: '2020-11-30' },
]

const fixtureSources: FixtureSnapshotSource[] = [
  { id: 'fixture-lease', sha256: 'd'.repeat(64) },
  { id: 'fixture-declaration', sha256: 'e'.repeat(64) },
]

describe('buildRunRecord', () => {
  it('records the pipeline-config snapshot and its content hash', () => {
    const record = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources,
      fixtureSources,
      includedDocumentIds: ['rta-2006', 'reg-516-06', 'fixture-lease', 'fixture-declaration'],
    })
    expect(record.pipelineConfig).toEqual(NAIVE_RAG_PIPELINE_CONFIG)
    expect(record.pipelineConfigHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('records exactly the manifest sources it measured, with checksums', () => {
    const record = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources,
      fixtureSources,
      includedDocumentIds: ['rta-2006', 'reg-516-06'],
    })
    expect(record.manifest.sources).toHaveLength(2)
    expect(record.manifest.sources[0]?.sha256).toHaveLength(64)
  })

  it('records the fixture sources it measured, with content checksums', () => {
    const record = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources,
      fixtureSources,
      includedDocumentIds: ['rta-2006', 'reg-516-06', 'fixture-lease', 'fixture-declaration'],
    })
    expect(record.fixtures.sources.map((s) => s.id)).toEqual([
      'fixture-lease',
      'fixture-declaration',
    ])
    expect(record.fixtures.sources.every((s) => /^[0-9a-f]{64}$/.test(s.sha256))).toBe(true)
  })

  it('validates against the run-record schema', () => {
    const record = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources,
      fixtureSources,
      includedDocumentIds: ['rta-2006'],
    })
    expect(() => runRecordSchema.parse(record)).not.toThrow()
  })

  it('derives a corpus-build hash from manifest + pipeline config (ADR 0004)', () => {
    const base = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources,
      fixtureSources,
      includedDocumentIds: ['rta-2006'],
    })
    const driftedManifest = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources: [{ ...manifestSources[0]!, sha256: 'c'.repeat(64) }, manifestSources[1]!],
      fixtureSources,
      includedDocumentIds: ['rta-2006'],
    })
    expect(base.corpusBuildHash).not.toBe(driftedManifest.corpusBuildHash)
  })

  it('changes the corpus-build hash when a fixture document changes content', () => {
    // The indexed corpus includes committed fixtures; two runs over different
    // fixture text must never report the same build (Codex P2 on PR #39).
    const base = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources,
      fixtureSources,
      includedDocumentIds: ['rta-2006', 'fixture-lease'],
    })
    const driftedFixture = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources,
      fixtureSources: [{ ...fixtureSources[0]!, sha256: 'f'.repeat(64) }, fixtureSources[1]!],
      includedDocumentIds: ['rta-2006', 'fixture-lease'],
    })
    expect(base.corpusBuildHash).not.toBe(driftedFixture.corpusBuildHash)
  })

  it('is insensitive to fixture-source ordering (canonical sort before hashing)', () => {
    const forward = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources,
      fixtureSources,
      includedDocumentIds: ['rta-2006'],
    })
    const reversed = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources,
      fixtureSources: [...fixtureSources].reverse(),
      includedDocumentIds: ['rta-2006'],
    })
    expect(forward.corpusBuildHash).toBe(reversed.corpusBuildHash)
  })

  it('excludes the checksum-failing rent-increase-guideline source by construction', () => {
    const record = buildRunRecord({
      config: NAIVE_RAG_PIPELINE_CONFIG,
      manifestSources,
      fixtureSources,
      includedDocumentIds: ['rta-2006', 'reg-516-06'],
    })
    expect(record.manifest.sources.map((s) => s.id)).not.toContain('rent-increase-guideline')
  })
})
