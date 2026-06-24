import { describe, expect, it, vi } from 'vitest'

import { type PipelineConfig } from '@owners-manual/enrichment'

import { authorityLevelOf } from '../authority.js'
import { type ChunkRow } from './mongo-store.js'
import { type PersistedEnrichmentBuild } from './enrichment-artifact.js'
import { resolveAgentEnrichment } from './enrichment-resolver.js'

/**
 * The PURE gating resolver for the agent's query-time enrichment access (#16).
 * `xrefExpansion` / `definitionsInPrompt` are DEFAULT-OFF A/B flags, so an off
 * run (the default agent, the naive-rag/stuff arms, the all-off ablation floor,
 * the smoke gate) must NOT require a live-LLM-built enrichment artifact just to
 * boot — flags off + no enrichment is the CORRECT behaviour. The resolver loads
 * the artifact ONLY when a flag requests it; flags-on-but-artifact-missing still
 * fails loud via the injected loader.
 */

const ALL_OFF = {
  rerank: false,
  rerankProvider: 'authority' as const,
  xrefExpansion: false,
  definitionsInPrompt: false,
  queryReformulation: false,
}

const ARTIFACT_PATH = 'corpus/enrichment/build.json'
const CORPUS_HASH = 'a'.repeat(64)

// The enrichment config the artifact was built under; serve passes the SAME value
// as `expectedEnrichmentConfig`, so a matching pair is the happy path and any
// drift (model swap / prompt-version bump) must fail loud (Codex P2, PR #78).
const ENRICHMENT_CONFIG: PipelineConfig = {
  chunkerId: 'hierarchy-v1',
  enrichmentModel: 'claude-enrichment-test',
  promptVersions: {
    'cross-references': 'v1',
    definitions: 'v1',
    'amendment-flags': 'v1',
    'situating-context': 'v1',
  },
}

const NOTICE_KEY = 'rta-2006|section:12'

const row = (citablePathKey: string, text: string): ChunkRow => ({
  id: `hierarchy-v1:${citablePathKey}`,
  citablePathKey,
  text,
  documentId: citablePathKey.split('|', 1)[0]!,
  chunker: 'hierarchy-v1',
  embedding: [0.1],
})

const build = (corpusBuildHash: string): PersistedEnrichmentBuild => ({
  corpusBuildHash,
  metadata: {
    buildHash: 'b'.repeat(64),
    manifestHash: 'c'.repeat(64),
    pipelineConfig: ENRICHMENT_CONFIG,
    enrichmentModel: ENRICHMENT_CONFIG.enrichmentModel,
  },
  trees: [
    {
      documentId: 'rta-2006',
      treeHash: 'd'.repeat(64),
      model: 'claude-enrichment-test',
      promptVersions: {
        'cross-references': 'v1',
        definitions: 'v1',
        'amendment-flags': 'v1',
      },
      crossReferences: [],
      definitions: {},
      amendmentFlags: [],
    },
  ],
})

describe('resolveAgentEnrichment', () => {
  it('returns undefined and touches NEITHER seam when both flags are off', async () => {
    const loadArtifact = vi.fn()
    const listChunks = vi.fn()

    const access = await resolveAgentEnrichment({
      flags: ALL_OFF,
      artifactPath: ARTIFACT_PATH,
      corpusBuildHash: CORPUS_HASH,
      expectedEnrichmentConfig: ENRICHMENT_CONFIG,
      loadArtifact,
      listChunks,
    })

    expect(access).toBeUndefined()
    expect(loadArtifact).not.toHaveBeenCalled()
    expect(listChunks).not.toHaveBeenCalled()
  })

  it('loads, guards, and returns an access whose lookup resolves when xrefExpansion is on', async () => {
    const loadArtifact = vi.fn(async () => build(CORPUS_HASH))
    const listChunks = vi.fn(async () => [row(NOTICE_KEY, 'Despite section 2, a notice is valid.')])

    const access = await resolveAgentEnrichment({
      flags: { ...ALL_OFF, xrefExpansion: true },
      artifactPath: ARTIFACT_PATH,
      corpusBuildHash: CORPUS_HASH,
      expectedEnrichmentConfig: ENRICHMENT_CONFIG,
      loadArtifact,
      listChunks,
    })

    expect(loadArtifact).toHaveBeenCalledWith(ARTIFACT_PATH)
    expect(listChunks).toHaveBeenCalledTimes(1)
    const resolved = access?.lookup(NOTICE_KEY)
    expect(resolved?.citablePathKey).toBe(NOTICE_KEY)
    expect(resolved?.authorityLevel).toBe(authorityLevelOf('rta-2006'))
  })

  it('loads when definitionsInPrompt is on (the other gate)', async () => {
    const loadArtifact = vi.fn(async () => build(CORPUS_HASH))
    const listChunks = vi.fn(async () => [] as readonly ChunkRow[])

    const access = await resolveAgentEnrichment({
      flags: { ...ALL_OFF, definitionsInPrompt: true },
      artifactPath: ARTIFACT_PATH,
      corpusBuildHash: CORPUS_HASH,
      expectedEnrichmentConfig: ENRICHMENT_CONFIG,
      loadArtifact,
      listChunks,
    })

    expect(access).toBeDefined()
    expect(loadArtifact).toHaveBeenCalledTimes(1)
  })

  it('throws when a flag is on but the loaded build is for a different corpus', async () => {
    const loadArtifact = vi.fn(async () => build('f'.repeat(64)))
    const listChunks = vi.fn(async () => [] as readonly ChunkRow[])

    await expect(
      resolveAgentEnrichment({
        flags: { ...ALL_OFF, xrefExpansion: true },
        artifactPath: ARTIFACT_PATH,
        corpusBuildHash: CORPUS_HASH,
        expectedEnrichmentConfig: ENRICHMENT_CONFIG,
        loadArtifact,
        listChunks,
      }),
    ).rejects.toThrow(/enrichment artifact corpus build hash/i)
    expect(listChunks).not.toHaveBeenCalled()
  })

  it('throws when corpus matches but the artifact enrichment config drifted (stale model)', async () => {
    // The artifact was built under ENRICHMENT_CONFIG (model claude-enrichment-test)
    // and its corpus hash matches — but serve now expects a DIFFERENT enrichment
    // model. The corpus hash is blind to that, so only the config guard catches it
    // (Codex P2, PR #78). Must fail fast, before the chunk-store read.
    const loadArtifact = vi.fn(async () => build(CORPUS_HASH))
    const listChunks = vi.fn(async () => [] as readonly ChunkRow[])

    await expect(
      resolveAgentEnrichment({
        flags: { ...ALL_OFF, xrefExpansion: true },
        artifactPath: ARTIFACT_PATH,
        corpusBuildHash: CORPUS_HASH,
        expectedEnrichmentConfig: { ...ENRICHMENT_CONFIG, enrichmentModel: 'claude-new-model' },
        loadArtifact,
        listChunks,
      }),
    ).rejects.toThrow(/enrichment/i)
    expect(listChunks).not.toHaveBeenCalled()
  })

  it('propagates the loader error loud when a flag is on but the artifact is missing', async () => {
    const loadArtifact = vi.fn(async () => {
      throw new Error('enrichment artifact not found at corpus/enrichment/build.json')
    })
    const listChunks = vi.fn()

    await expect(
      resolveAgentEnrichment({
        flags: { ...ALL_OFF, xrefExpansion: true },
        artifactPath: ARTIFACT_PATH,
        corpusBuildHash: CORPUS_HASH,
        expectedEnrichmentConfig: ENRICHMENT_CONFIG,
        loadArtifact,
        listChunks,
      }),
    ).rejects.toThrow(/enrichment artifact not found/i)
    expect(listChunks).not.toHaveBeenCalled()
  })
})
