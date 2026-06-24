/**
 * The fail-loud identity guards for the live enrichment binding (#16). Two
 * INDEPENDENT axes must match, because they hash over disjoint inputs:
 *
 *   1. {@link assertEnrichmentBuildMatchesCorpus} — the CORPUS build hash
 *      (`hash(manifest + naive-rag config)`, ADR 0004). The agent's graph
 *      expansion grafts the sidecars' cross-reference edges onto chunks from the
 *      retrieval store; if the sidecars were built against a different corpus,
 *      expansion grafts edges from one build onto chunks from another — a silent
 *      correctness hole the eval would only see as worse numbers.
 *   2. {@link assertEnrichmentConfigCurrent} — the ENRICHMENT config
 *      (`hash(model + chunker + prompt versions)`, ADR 0004/0005). The corpus
 *      hash is BLIND to this (the enrichment model/prompts live in the build's own
 *      `metadata.pipelineConfig`, not the corpus manifest), so an `ENRICHMENT_MODEL`
 *      or prompt-version bump does NOT move the corpus hash. Without this second
 *      guard a stale artifact built by the OLD model passes axis 1 and serve
 *      silently feeds obsolete graph/definitions sidecars to the agent.
 *
 * Both are equality assertions that THROW at serve start (CONTEXT.md / coding
 * style: fail loud on a misconfiguration, never a quiet fallback). Pure over their
 * inputs so they are unit-tested offline.
 */

import { hashPipelineConfig, type PipelineConfig } from '@owners-manual/enrichment'

/** The two corpus build hashes the guard reconciles. */
export interface EnrichmentBuildGuardInput {
  /** The `corpusBuildHash` the persisted enrichment artifact was built against. */
  readonly artifactCorpusBuildHash: string
  /** The `corpusBuildHash` serve derives from its run record (the corpus it serves). */
  readonly corpusBuildHash: string
}

/**
 * Assert the persisted enrichment build was produced against the corpus serve is
 * answering over. Throws a descriptive error naming both hashes when they
 * disagree — a stale or wrong-corpus artifact is a configuration error surfaced
 * here, by hash, rather than as a mis-grafted expansion target mid query.
 */
export function assertEnrichmentBuildMatchesCorpus(input: EnrichmentBuildGuardInput): void {
  if (input.artifactCorpusBuildHash !== input.corpusBuildHash) {
    throw new Error(
      'enrichment artifact corpus build hash does not match the serving corpus: ' +
        `artifact "${input.artifactCorpusBuildHash}" vs serve "${input.corpusBuildHash}". ` +
        'Re-run `enrich:build` against the current corpus before serving.',
    )
  }
}

/** The two enrichment {@link PipelineConfig}s the config guard reconciles. */
export interface EnrichmentConfigGuardInput {
  /** The enrichment config recorded in the persisted artifact (`metadata.pipelineConfig`). */
  readonly artifactEnrichmentConfig: PipelineConfig
  /** The enrichment config serve currently expects (the pinned `ENRICHMENT_PIPELINE_CONFIG`). */
  readonly expectedEnrichmentConfig: PipelineConfig
}

/**
 * Assert the persisted artifact's enrichment config matches the one serve expects
 * — the axis the corpus build hash is blind to (model + chunker + prompt
 * versions). Compares the content-addressed {@link hashPipelineConfig} of each
 * (so key order is irrelevant) and THROWS, naming both `enrichmentModel`s and the
 * two config hashes, when they drift: a stale artifact built by a since-bumped
 * model/prompt is a configuration error surfaced here, by hash, rather than as
 * obsolete sidecars silently feeding the agent.
 */
export function assertEnrichmentConfigCurrent(input: EnrichmentConfigGuardInput): void {
  const artifactHash = hashPipelineConfig(input.artifactEnrichmentConfig)
  const expectedHash = hashPipelineConfig(input.expectedEnrichmentConfig)
  if (artifactHash !== expectedHash) {
    throw new Error(
      'enrichment artifact config does not match the serving enrichment config: ' +
        `artifact model "${input.artifactEnrichmentConfig.enrichmentModel}" (config ${artifactHash}) ` +
        `vs serve model "${input.expectedEnrichmentConfig.enrichmentModel}" (config ${expectedHash}). ` +
        'Re-run `enrich:build` with the current enrichment config before serving.',
    )
  }
}
