import { describe, expect, it } from 'vitest'

import {
  type BuildMetadata,
  type PipelineConfig,
  type TreeEnrichment,
} from '@owners-manual/enrichment'

import {
  loadEnrichmentArtifact,
  serializeEnrichmentArtifact,
  type PersistedEnrichmentBuild,
} from './enrichment-artifact.js'

/**
 * The PURE serialization layer for the persisted enrichment artifact (#16): the
 * serve side loads what the `enrich:build` CLI wrote, so a malformed or
 * truncated artifact must fail loudly with a descriptive error rather than
 * surfacing as an `undefined` sidecar at query time. The round-trip and the
 * malformed-throws cases are what `runEnrichmentBuild` itself never re-validates
 * (it produces the build in memory; persistence crosses a trust boundary).
 */

const ENRICHMENT_CONFIG: PipelineConfig = {
  chunkerId: 'hierarchy-v1',
  enrichmentModel: 'claude-enrichment-test',
  promptVersions: {
    'cross-references': 'xref-v1',
    definitions: 'def-v1',
    'amendment-flags': 'amend-v1',
    'situating-context': 'situ-v1',
  },
}

const METADATA: BuildMetadata = {
  buildHash: 'a'.repeat(64),
  manifestHash: 'b'.repeat(64),
  pipelineConfig: ENRICHMENT_CONFIG,
  enrichmentModel: 'claude-enrichment-test',
}

// A tree sidecar carries only the THREE tree-level pass versions — the 4th
// pipeline pass (`situating-context`) is chunk-level and never persisted in a
// tree (only `trees` are serialized; chunk enrichment is not). So the artifact's
// `treeEnrichmentSchema` requires exactly these three, even though the enrichment
// `PipelineConfig` carries four prompt versions.
const TREE: TreeEnrichment = {
  documentId: 'rta-2006',
  treeHash: 'c'.repeat(64),
  model: 'claude-enrichment-test',
  promptVersions: {
    'cross-references': 'xref-v1',
    definitions: 'def-v1',
    'amendment-flags': 'amend-v1',
  },
  crossReferences: [{ from: 'rta-2006|section:12', to: 'rta-2006|section:2', kind: 'despite' }],
  definitions: { Board: 'rta-2006|section:2' },
  amendmentFlags: [{ path: 'rta-2006|section:241', note: 'not yet in force' }],
}

const BUILD: PersistedEnrichmentBuild = {
  corpusBuildHash: 'd'.repeat(64),
  metadata: METADATA,
  trees: [TREE],
}

describe('enrichment artifact serialization', () => {
  it('round-trips a persisted build to JSON and back with structural equality', () => {
    const json = serializeEnrichmentArtifact(BUILD)
    const reloaded = loadEnrichmentArtifact(json)
    expect(reloaded).toEqual(BUILD)
  })

  it('produces pretty-printed JSON that parses to the same value', () => {
    const json = serializeEnrichmentArtifact(BUILD)
    expect(json).toContain('\n')
    expect(loadEnrichmentArtifact(json)).toEqual(BUILD)
  })

  it('throws descriptively on JSON that is not even parseable', () => {
    expect(() => loadEnrichmentArtifact('{ not json')).toThrow(/enrichment artifact.*JSON/i)
  })

  it('throws descriptively when the corpus build hash is malformed', () => {
    const json = serializeEnrichmentArtifact(BUILD)
    const tampered = JSON.parse(json) as Record<string, unknown>
    tampered.corpusBuildHash = 'too-short'
    expect(() => loadEnrichmentArtifact(JSON.stringify(tampered))).toThrow(/enrichment artifact/i)
  })

  it('throws when a cross-reference edge is missing its required fields', () => {
    const json = serializeEnrichmentArtifact(BUILD)
    const tampered = JSON.parse(json) as {
      trees: Array<{ crossReferences: unknown[] }>
    }
    tampered.trees[0]!.crossReferences = [{ from: 'rta-2006|section:12' }]
    expect(() => loadEnrichmentArtifact(JSON.stringify(tampered))).toThrow(/enrichment artifact/i)
  })

  it('throws when a required top-level section is absent', () => {
    const json = serializeEnrichmentArtifact(BUILD)
    const tampered = JSON.parse(json) as Record<string, unknown>
    delete tampered.trees
    expect(() => loadEnrichmentArtifact(JSON.stringify(tampered))).toThrow(/enrichment artifact/i)
  })
})
