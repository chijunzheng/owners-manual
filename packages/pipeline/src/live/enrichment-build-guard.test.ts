import { describe, expect, it } from 'vitest'

import { assertEnrichmentBuildMatchesCorpus } from './enrichment-build-guard.js'

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
