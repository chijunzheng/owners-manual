/**
 * The pinned enrichment pipeline config (#16) — the build identity for the
 * offline tree-level enrichment the agent's query-time graph expansion +
 * definitions attachment consume.
 *
 * ADR 0004 content-addresses corpus builds as `hash(source manifest + pipeline
 * config)`, and ADR 0005 puts the enrichment model string IN that config (and
 * therefore in the build hash): a model swap must move the hash, exactly as the
 * naive-rag arm's `NAIVE_RAG_PIPELINE_CONFIG` pins its runtime Gemini model. So —
 * unlike the offline JUDGE model, which is grader infra read fail-loud from env —
 * the enrichment model is PINNED here as build identity, and the live `claude -p`
 * client is constructed FROM this string so the two can never disagree
 * (`runEnrichmentBuild` asserts the injected client's model equals
 * `config.enrichmentModel`, and that every pass carries a prompt version).
 *
 * The Claude model is the current STABLE FLAGSHIP (avoid `-preview`); the chunker
 * id matches #14's hierarchy chunker (the chunk-level pass keys off it — the
 * tree-level sidecars the agent reads key off the tree hash and are chunker-
 * independent). Every enrichment pass (`TREE_PASSES` + `situating-context`) has a
 * prompt version, or `runEnrichmentBuild` throws by name before any client call.
 */

import {
  hierarchyChunker,
  SITUATING_CONTEXT_PASS,
  TREE_PASSES,
  type PipelineConfig,
} from '@owners-manual/enrichment'

/**
 * The pinned enrichment model (ADR 0005: Claude via `claude -p`, billed to the
 * Max subscription credit). A stable flagship string — part of the corpus build
 * hash, so a swap is a visible build change. The live client is built from this
 * exact string (enrich-cli), never a divergent hardcode.
 */
export const ENRICHMENT_MODEL = 'claude-opus-4-8'

/** The pinned prompt version for every enrichment pass (bump to re-run that pass). */
const ENRICHMENT_PROMPT_VERSIONS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(TREE_PASSES.map((pass) => [pass, 'v1'])),
  [SITUATING_CONTEXT_PASS]: 'v1',
}

/**
 * The canonical enrichment pipeline config. `enrichmentModel` MUST equal
 * {@link ENRICHMENT_MODEL} (the live client is constructed from the same
 * constant); `chunkerId` MUST equal the chunker the build runs over
 * ({@link hierarchyChunker.id}) — `runEnrichmentBuild` asserts both and fails
 * loud on a drift, so a build can never be mislabeled by its own identity.
 */
export const ENRICHMENT_PIPELINE_CONFIG: PipelineConfig = {
  chunkerId: hierarchyChunker.id,
  enrichmentModel: ENRICHMENT_MODEL,
  promptVersions: ENRICHMENT_PROMPT_VERSIONS,
}
