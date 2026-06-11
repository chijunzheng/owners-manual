/**
 * The build entry point: one function that wires the completed enrichment slices
 * into a single content-addressed {@link EnrichmentBuild} (issue #13).
 *
 * Every per-document slice already stands alone — {@link enrichTree} produces the
 * tree-level sidecar keyed to the tree hash, {@link enrichChunks} produces the
 * chunk-level situating contexts keyed to chunk hash + prompt version — and the
 * caches, the fake/real client seam, and the chunker are all injected. This entry
 * point does only the wiring the build needs and nothing the slices already do:
 *
 *   - it asserts the injected dependencies agree with the config (the config IS
 *     the build identity, so a drifting chunker or model must never silently
 *     produce a mis-labeled build);
 *   - it asserts the config carries a prompt version for every pass the build
 *     runs (a missing entry is a configuration error, surfaced descriptively
 *     before any client call rather than as a downstream `undefined`);
 *   - it runs both per-document slices over each document and pairs the results
 *     with {@link computeBuildMetadata}, the content-address that pins an eval to
 *     this exact corpus build.
 *
 * It re-uses the slices verbatim (never re-implements their cache keying, their
 * batching, or their anti-hallucination guards), so every acceptance property the
 * slices already prove — 100% cache hits on re-run, chunker-only invalidation,
 * the build-hash "iff", no re-authored source text — flows through unchanged.
 */

import type { ParsedDocument } from '@owners-manual/parser'

import type { ClaudeClient } from './claude-client.js'
import type { EnrichmentCache } from './cache.js'
import type { Chunker } from './chunk.js'
import { enrichChunks, SITUATING_CONTEXT_PASS, type ChunkEnrichment } from './chunk-enrichment.js'
import { computeBuildMetadata, type BuildMetadata, type PipelineConfig } from './pipeline-config.js'
import { enrichTree, TREE_PASSES, type TreeEnrichment, type TreePass } from './tree-enrichment.js'

/** Every enrichment pass the build runs, each of which needs a prompt version. */
const REQUIRED_PASSES = [...TREE_PASSES, SITUATING_CONTEXT_PASS] as const

/**
 * One enrichment build: the content-addressed {@link BuildMetadata} that pins it
 * to an exact corpus, plus the per-document tree- and chunk-level sidecars in
 * document order. A value, not a process — fully serializable and comparable.
 */
export interface EnrichmentBuild {
  readonly metadata: BuildMetadata
  readonly trees: readonly TreeEnrichment[]
  readonly chunks: readonly ChunkEnrichment[]
}

/** The wiring inputs for {@link runEnrichmentBuild}; all seams, no globals. */
export interface RunEnrichmentBuildInput {
  /** The parsed source documents to enrich, in build order. */
  readonly documents: readonly ParsedDocument[]
  /** The opaque manifest hash the corpus package computed (build identity input). */
  readonly manifestHash: string
  /** The pipeline config — the build identity downstream of source bytes. */
  readonly config: PipelineConfig
  /** The injected Claude seam (the fake under test, the real adapter in prod). */
  readonly client: ClaudeClient
  /** The chunking strategy; its id MUST match {@link PipelineConfig.chunkerId}. */
  readonly chunker: Chunker
  /** The per-stage content-addressed caches, separate for tree- and chunk-level. */
  readonly caches: {
    readonly tree: EnrichmentCache<string>
    readonly chunk: EnrichmentCache<string>
  }
}

/**
 * Assert the injected dependencies agree with the config they will be recorded
 * under. The config is the build's identity, so a chunker or model that drifts
 * from it would mint a build labeled by one identity but produced by another;
 * fail loudly up front instead.
 */
function assertCoherentDependencies(input: RunEnrichmentBuildInput): void {
  const { chunker, client, config } = input
  if (chunker.id !== config.chunkerId) {
    throw new Error(
      `enrichment build: injected chunker id "${chunker.id}" does not match ` +
        `config.chunkerId "${config.chunkerId}"`,
    )
  }
  if (client.model !== config.enrichmentModel) {
    throw new Error(
      `enrichment build: injected client model "${client.model}" does not match ` +
        `config.enrichmentModel "${config.enrichmentModel}"`,
    )
  }
}

/**
 * Assert the config carries a prompt version for every pass the build runs (the
 * three tree passes plus situating-context). A missing entry is a configuration
 * error surfaced here, by name, rather than as a downstream `undefined` prompt
 * version flowing into a cache key.
 */
function assertPromptVersions(config: PipelineConfig): void {
  for (const pass of REQUIRED_PASSES) {
    const version = config.promptVersions[pass]
    if (version === undefined || version === '') {
      throw new Error(
        `enrichment build: config.promptVersions is missing a non-empty entry for pass "${pass}"`,
      )
    }
  }
}

/** The tree-pass prompt-version map, projected from the validated config. */
function treePromptVersions(config: PipelineConfig): Readonly<Record<TreePass, string>> {
  return Object.fromEntries(
    TREE_PASSES.map((pass) => [pass, config.promptVersions[pass]!]),
  ) as Record<TreePass, string>
}

/**
 * Run the full offline enrichment build: validate coherence and prompt versions,
 * enrich every document at both tree- and chunk-level through the injected slices
 * and caches, and pair the sidecars with the content-addressed build metadata.
 * Pure over its inputs (the slices never mutate the documents); throws on any
 * incoherent dependency, missing prompt version, or slice-level fidelity
 * violation (malformed or hallucinating LLM output).
 */
export async function runEnrichmentBuild(input: RunEnrichmentBuildInput): Promise<EnrichmentBuild> {
  assertCoherentDependencies(input)
  assertPromptVersions(input.config)

  const { documents, manifestHash, config, client, chunker, caches } = input
  const promptVersions = treePromptVersions(config)
  const situatingContextVersion = config.promptVersions[SITUATING_CONTEXT_PASS]!

  const trees: TreeEnrichment[] = []
  const chunks: ChunkEnrichment[] = []

  for (const document of documents) {
    const [tree, chunk] = await Promise.all([
      enrichTree(document, { client, cache: caches.tree, promptVersions }),
      enrichChunks(document, {
        chunker,
        client,
        cache: caches.chunk,
        promptVersion: situatingContextVersion,
      }),
    ])
    trees.push(tree)
    chunks.push(chunk)
  }

  return {
    metadata: computeBuildMetadata({ manifestHash, pipelineConfig: config }),
    trees,
    chunks,
  }
}
