/**
 * The run record — what the harness measured (issue #10 AC4: "Run records the
 * manifest + pipeline-config snapshot it measured").
 *
 * ADR 0004 pins comparability: two eval numbers are comparable only if their
 * builds are known, and a build is `hash(source manifest + pipeline config)`.
 * This record pins both halves — the exact manifest source checksums +
 * consolidation dates the corpus was built from, and the full pipeline-config
 * snapshot with its hash — and derives the corpus-build hash that names this
 * build. The service returns it to the harness, which attaches it to the
 * experiment so every published number traces back to an exact build.
 *
 * The checksum-failing `rent-increase-guideline` source (upstream drift, known
 * issue) is excluded by construction: the caller passes only the sources it
 * actually ingested, and that source is never among them.
 */

import { createHash } from 'node:crypto'

import { z } from 'zod'

import { pipelineConfigHash, pipelineConfigSchema, type PipelineConfig } from './pipeline-config.js'

/** One manifest source as recorded in the build: id, checksum, currency date. */
export const manifestSnapshotSourceSchema = z
  .object({
    id: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    consolidationDate: z.string().min(1),
  })
  .strict()

export type ManifestSnapshotSource = z.infer<typeof manifestSnapshotSourceSchema>

export const runRecordSchema = z
  .object({
    /** The exact manifest sources this build measured. */
    manifest: z.object({ sources: z.array(manifestSnapshotSourceSchema) }).strict(),
    /** The full pipeline-config snapshot. */
    pipelineConfig: pipelineConfigSchema,
    /** The content hash of {@link pipelineConfig}. */
    pipelineConfigHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** The corpus-build hash: hash(manifest + pipeline config) — ADR 0004. */
    corpusBuildHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** The document ids actually ingested into this build, in order. */
    includedDocumentIds: z.array(z.string().min(1)),
  })
  .strict()

export type RunRecord = z.infer<typeof runRecordSchema>

export interface BuildRunRecordOptions {
  readonly config: PipelineConfig
  readonly manifestSources: readonly ManifestSnapshotSource[]
  readonly includedDocumentIds: readonly string[]
}

/** Build (and validate) the run record for one corpus build. */
export function buildRunRecord(options: BuildRunRecordOptions): RunRecord {
  const { config, manifestSources, includedDocumentIds } = options
  const configHash = pipelineConfigHash(config)
  const manifestDigest = createHash('sha256')
    .update(
      JSON.stringify(
        [...manifestSources]
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((source) => [source.id, source.sha256, source.consolidationDate]),
      ),
      'utf8',
    )
    .digest('hex')
  const corpusBuildHash = createHash('sha256')
    .update(`${manifestDigest}:${configHash}`, 'utf8')
    .digest('hex')

  return runRecordSchema.parse({
    manifest: { sources: manifestSources },
    pipelineConfig: config,
    pipelineConfigHash: configHash,
    corpusBuildHash,
    includedDocumentIds,
  })
}
