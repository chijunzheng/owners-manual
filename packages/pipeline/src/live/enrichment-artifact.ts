/**
 * The persisted enrichment artifact (#16): the PURE serialize/load boundary
 * between the `enrich:build` CLI (producer) and `naive-rag:serve` (consumer) for
 * #13's tree-level sidecars.
 *
 * The agent's query-time graph expansion and definitions attachment read the
 * already-built {@link TreeEnrichment} sidecars (ADR 0004: flags flip at
 * consumers, never producers) — but the build runs offline (Claude via `claude
 * -p`, ADR 0005), so serve loads a gitignored JSON artifact rather than re-running
 * it. Persistence crosses a trust boundary `runEnrichmentBuild` never does (it
 * holds the build in memory), so the loaded bytes are UNTYPED input: parsed with
 * zod and rejected — descriptively, fail-loud — on malformed JSON or any schema
 * drift, so a truncated artifact can never surface as an `undefined` sidecar mid
 * query.
 *
 * The schema is COMPOSED from `@owners-manual/enrichment`'s already-exported field
 * schemas (cross-reference / definitions / amendment / pipeline-config), never a
 * second hand-rolled copy — so the producer's fidelity guarantees and the
 * consumer's validation can never drift apart. Only the `trees` slice of the
 * {@link EnrichmentBuild} is persisted (plus its build identity): the agent's
 * query-time consumers read the tree-level graph + definitions, never the
 * chunk-level situating contexts, so the artifact stays lean and focused.
 */

import {
  amendmentFlagSchema,
  crossReferenceEdgeSchema,
  definitionsIndexSchema,
  pipelineConfigSchema,
  TREE_PASSES,
  type BuildMetadata,
  type TreeEnrichment,
} from '@owners-manual/enrichment'
import { z } from 'zod'

/** A lowercase hex SHA-256, the shape every build/tree/manifest hash takes. */
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * The tree-pass prompt-version map: a non-empty version for EACH of the three
 * passes and no other key (`strict`). Explicit per-pass keys (not a record) so the
 * inferred type is exactly `Record<TreePass, string>`, matching
 * {@link import('@owners-manual/enrichment').TreeEnrichment.promptVersions}.
 */
const treePromptVersionsSchema = z
  .object({
    'cross-references': z.string().min(1),
    definitions: z.string().min(1),
    'amendment-flags': z.string().min(1),
  })
  .strict() satisfies z.ZodType<Record<(typeof TREE_PASSES)[number], string>>

/**
 * One tree-level sidecar, composed from the enrichment package's own field
 * schemas. Mirrors {@link import('@owners-manual/enrichment').TreeEnrichment}
 * field for field; `strict` so an unknown key in a persisted artifact is rejected
 * rather than silently dropped (the artifact is build-identity-bearing).
 */
const treeEnrichmentSchema = z
  .object({
    documentId: z.string().min(1),
    treeHash: hashSchema,
    model: z.string().min(1),
    promptVersions: treePromptVersionsSchema,
    crossReferences: z.array(crossReferenceEdgeSchema),
    definitions: definitionsIndexSchema,
    amendmentFlags: z.array(amendmentFlagSchema),
  })
  .strict()

/**
 * The enrichment build's content-addressed identity, composed around the
 * enrichment package's {@link pipelineConfigSchema}. Mirrors
 * {@link import('@owners-manual/enrichment').BuildMetadata}.
 */
const buildMetadataSchema = z
  .object({
    buildHash: hashSchema,
    manifestHash: hashSchema,
    pipelineConfig: pipelineConfigSchema,
    enrichmentModel: z.string().min(1),
  })
  .strict()

/**
 * The persisted artifact's shape. `corpusBuildHash` is the SAME hash
 * `naive-rag:serve` derives from its run record (manifest + fixtures + pipeline
 * config) — recorded here so the serve-side guard can fail loud when the loaded
 * sidecars were built against a different corpus than the one being served. The
 * enrichment `metadata` is retained for provenance; `trees` are what the agent
 * reads.
 */
const persistedEnrichmentBuildSchema = z
  .object({
    corpusBuildHash: hashSchema,
    metadata: buildMetadataSchema,
    trees: z.array(treeEnrichmentSchema),
  })
  .strict()

/**
 * The serializable enrichment build: the serve-side corpus pin, the enrichment
 * build identity, and the tree-level sidecars the agent's query-time graph
 * expansion + definitions attachment read.
 *
 * Composed from the enrichment package's READONLY domain types (not the zod
 * schema's inferred mutable shape) so a real {@link EnrichmentBuild}'s
 * `readonly` sidecars serialize without a copy; the schema above stays the
 * runtime validator the two functions enforce on the persistence boundary.
 */
export interface PersistedEnrichmentBuild {
  /** The corpus build hash serve reconciles against its run record (the pin). */
  readonly corpusBuildHash: string
  /** The enrichment build's content-addressed identity, kept for provenance. */
  readonly metadata: BuildMetadata
  /** The tree-level sidecars the agent's query-time consumers read. */
  readonly trees: readonly TreeEnrichment[]
}

/**
 * Serialize a persisted build to pretty-printed JSON (pretty so a committed-by-
 * accident artifact diffs readably and a human can eyeball it). Validates on the
 * way out so a producer can never write a structurally-invalid artifact the
 * consumer would only reject later.
 */
export function serializeEnrichmentArtifact(build: PersistedEnrichmentBuild): string {
  // Validate on the way out (the parameter type is already pinned; this guards a
  // hand-constructed value), then pretty-print. The cast to `unknown` is only to
  // hand zod the readonly value — zod validates structure, not mutability.
  return JSON.stringify(persistedEnrichmentBuildSchema.parse(build as unknown), null, 2)
}

/**
 * Parse-and-validate a persisted artifact's JSON, throwing a descriptive,
 * `enrichment artifact`-prefixed error on malformed JSON or any schema violation
 * — so a truncated or drifted artifact fails loud at serve start rather than as a
 * downstream `undefined` sidecar at query time.
 */
export function loadEnrichmentArtifact(json: string): PersistedEnrichmentBuild {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`enrichment artifact is not valid JSON: ${reason}`)
  }
  const result = persistedEnrichmentBuildSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`enrichment artifact failed validation: ${result.error.message}`)
  }
  // The schema mirrors {@link PersistedEnrichmentBuild} field for field; the cast
  // re-narrows the validated value from the schema's mutable inferred shape to the
  // readonly domain type the consumers treat it as.
  return result.data as PersistedEnrichmentBuild
}
