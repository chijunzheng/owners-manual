import { describe, expect, it } from 'vitest'

import { type PipelineConfig } from '@owners-manual/enrichment'

import {
  assertEnrichmentBuildMatchesCorpus,
  assertEnrichmentConfigCurrent,
} from './enrichment-build-guard.js'

/**
 * The fail-loud corpus-identity guard (#16): the loaded enrichment sidecars must
 * have been built against the SAME corpus serve is answering over, or expansion
 * would resolve cross-reference targets against one build while retrieval runs on
 * another — a silent correctness hole. A mismatching pair MUST throw at serve
 * start, never degrade quietly.
 */

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

describe('assertEnrichmentBuildMatchesCorpus', () => {
  it('passes when the artifact build hash matches the serve corpus build hash', () => {
    expect(() =>
      assertEnrichmentBuildMatchesCorpus({
        artifactCorpusBuildHash: HASH_A,
        corpusBuildHash: HASH_A,
      }),
    ).not.toThrow()
  })

  it('throws a descriptive error when the two build hashes disagree', () => {
    expect(() =>
      assertEnrichmentBuildMatchesCorpus({
        artifactCorpusBuildHash: HASH_A,
        corpusBuildHash: HASH_B,
      }),
    ).toThrow(/enrichment .*build/i)
  })

  it('names both hashes in the mismatch error so the drift is diagnosable', () => {
    expect(() =>
      assertEnrichmentBuildMatchesCorpus({
        artifactCorpusBuildHash: HASH_A,
        corpusBuildHash: HASH_B,
      }),
    ).toThrow(new RegExp(`${HASH_A}[\\s\\S]*${HASH_B}|${HASH_B}[\\s\\S]*${HASH_A}`))
  })
})

/**
 * The fail-loud enrichment-CONFIG guard (#16, Codex P2 on PR #78). The corpus
 * build hash is blind to the enrichment config (model + prompt versions, which
 * live in `metadata.pipelineConfig`), so an `ENRICHMENT_MODEL`/prompt-version bump
 * does NOT move the corpus hash. Without this guard a stale artifact built by the
 * OLD model still passes `assertEnrichmentBuildMatchesCorpus` and serve silently
 * feeds obsolete sidecars to the agent — exactly the content-addressed + fail-loud
 * hole ADR 0004/0005 forbids. This reconciles the enrichment config itself.
 */

const baseConfig: PipelineConfig = {
  chunkerId: 'hierarchy-v1',
  enrichmentModel: 'claude-enrichment-test',
  promptVersions: {
    'cross-references': 'v1',
    definitions: 'v1',
    'amendment-flags': 'v1',
    'situating-context': 'v1',
  },
}

describe('assertEnrichmentConfigCurrent', () => {
  it('passes when the artifact and expected enrichment configs match', () => {
    expect(() =>
      assertEnrichmentConfigCurrent({
        artifactEnrichmentConfig: baseConfig,
        expectedEnrichmentConfig: { ...baseConfig },
      }),
    ).not.toThrow()
  })

  it('throws when the enrichment model differs (a model swap serve never re-ingested)', () => {
    expect(() =>
      assertEnrichmentConfigCurrent({
        artifactEnrichmentConfig: { ...baseConfig, enrichmentModel: 'claude-old-model' },
        expectedEnrichmentConfig: baseConfig,
      }),
    ).toThrow(/enrichment/i)
  })

  it('names both enrichment models in the model-drift error', () => {
    expect(() =>
      assertEnrichmentConfigCurrent({
        artifactEnrichmentConfig: { ...baseConfig, enrichmentModel: 'claude-old-model' },
        expectedEnrichmentConfig: baseConfig,
      }),
    ).toThrow(
      /claude-old-model[\s\S]*claude-enrichment-test|claude-enrichment-test[\s\S]*claude-old-model/,
    )
  })

  it('throws when a prompt version is bumped (config hash moves, corpus hash does not)', () => {
    expect(() =>
      assertEnrichmentConfigCurrent({
        artifactEnrichmentConfig: baseConfig,
        expectedEnrichmentConfig: {
          ...baseConfig,
          promptVersions: { ...baseConfig.promptVersions, definitions: 'v2' },
        },
      }),
    ).toThrow(/enrichment/i)
  })
})
