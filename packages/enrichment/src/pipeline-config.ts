/**
 * The content-addressed build identity (ADR 0004: "Corpus builds are
 * content-addressed — `hash(source manifest + pipeline config)` — so every eval
 * result pins to an exact build").
 *
 * The {@link PipelineConfig} captures everything downstream of the source bytes
 * that can change what a build produces: which chunker ran, which enrichment
 * model wrote the LLM flesh, and the version of each enrichment prompt (bumping
 * a prompt version is how a prompt change invalidates the caches keyed on it).
 * The {@link BuildMetadata} pairs that config with an opaque, pre-computed
 * manifest hash (the corpus package hashes `corpus/manifest.json` itself, so
 * enrichment stays decoupled from it) and derives the build hash that pins an
 * eval to an exact corpus. Because the build hash is a SHA-256 over the
 * canonical serialization of (manifestHash, pipelineConfig), it changes iff one
 * of those inputs changes — the "iff" the acceptance criterion asserts.
 */

import { createHash } from 'node:crypto'

import { z } from 'zod'

/**
 * The pipeline configuration: the part of build identity that lives downstream
 * of source bytes. `promptVersions` maps an enrichment-pass name (e.g.
 * 'situating-context', 'cross-references') to an opaque version string; bumping
 * one is how a prompt change propagates into the build hash and invalidates the
 * downstream caches keyed on it.
 */
export interface PipelineConfig {
  readonly chunkerId: string
  readonly enrichmentModel: string
  readonly promptVersions: Readonly<Record<string, string>>
}

/** Validates untyped input into a {@link PipelineConfig}; all fields required, non-empty. */
export const pipelineConfigSchema = z.object({
  chunkerId: z.string().min(1),
  enrichmentModel: z.string().min(1),
  promptVersions: z.record(z.string(), z.string().min(1)),
})

/** Parse-and-validate untyped input into a {@link PipelineConfig}, throwing on any violation. */
export function parsePipelineConfig(value: unknown): PipelineConfig {
  return pipelineConfigSchema.parse(value)
}

/**
 * Deterministic JSON serialization: object keys sorted recursively (arrays keep
 * their order), so two values that differ only in key insertion order serialize
 * identically. This is what makes the build hash depend on the configuration's
 * values and never on how its JSON happened to be keyed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
  return `{${entries.join(',')}}`
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Content-addresses a pipeline config: SHA-256 over its canonical serialization. */
export function hashPipelineConfig(config: PipelineConfig): string {
  return sha256Hex(canonicalJson(config))
}

/**
 * The recorded identity of a build: the content-address (`buildHash`) plus the
 * exact inputs that produced it. `enrichmentModel` is duplicated at the top
 * level deliberately — the acceptance criterion requires the model to be
 * recorded in build metadata, and surfacing it here keeps build reports from
 * having to reach into `pipelineConfig`.
 */
export interface BuildMetadata {
  readonly buildHash: string
  readonly manifestHash: string
  readonly pipelineConfig: PipelineConfig
  readonly enrichmentModel: string
}

/**
 * Derives {@link BuildMetadata} from a pre-computed manifest hash and a pipeline
 * config. The build hash is the SHA-256 over the canonical serialization of
 * `{ manifestHash, pipelineConfig }`, so it changes iff one of those changes.
 * The manifest hash is opaque here — the corpus package computes it from the
 * manifest bytes — which keeps enrichment decoupled from the corpus package.
 */
export function computeBuildMetadata(input: {
  manifestHash: string
  pipelineConfig: PipelineConfig
}): BuildMetadata {
  const { manifestHash, pipelineConfig } = input
  return {
    buildHash: sha256Hex(canonicalJson({ manifestHash, pipelineConfig })),
    manifestHash,
    pipelineConfig,
    enrichmentModel: pipelineConfig.enrichmentModel,
  }
}
