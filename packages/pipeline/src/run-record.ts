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

/**
 * One committed fixture as recorded in the build: id + content checksum. The
 * indexed corpus includes fixtures, so their bytes must pin the build exactly
 * like manifest sources do — otherwise a fixture edit silently reuses the old
 * `corpusBuildHash` while retrieving different text (Codex P2, PR #39).
 */
export const fixtureSnapshotSourceSchema = z
  .object({
    id: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type FixtureSnapshotSource = z.infer<typeof fixtureSnapshotSourceSchema>

export const runRecordSchema = z
  .object({
    /** The exact manifest sources this build measured. */
    manifest: z.object({ sources: z.array(manifestSnapshotSourceSchema) }).strict(),
    /** The exact committed fixtures this build ingested, by content checksum. */
    fixtures: z.object({ sources: z.array(fixtureSnapshotSourceSchema) }).strict(),
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
  readonly fixtureSources: readonly FixtureSnapshotSource[]
  readonly includedDocumentIds: readonly string[]
}

/** Canonical digest of id-sorted source tuples — order-insensitive by design. */
function sortedTupleDigest(tuples: readonly (readonly string[])[]): string {
  const sorted = [...tuples].sort((a, b) =>
    (a[0] ?? '') < (b[0] ?? '') ? -1 : (a[0] ?? '') > (b[0] ?? '') ? 1 : 0,
  )
  return createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex')
}

/** Build (and validate) the run record for one corpus build. */
export function buildRunRecord(options: BuildRunRecordOptions): RunRecord {
  const { config, manifestSources, fixtureSources, includedDocumentIds } = options
  const configHash = pipelineConfigHash(config)
  const manifestDigest = sortedTupleDigest(
    manifestSources.map((source) => [source.id, source.sha256, source.consolidationDate]),
  )
  const fixtureDigest = sortedTupleDigest(
    fixtureSources.map((source) => [source.id, source.sha256]),
  )
  const corpusBuildHash = createHash('sha256')
    .update(`${manifestDigest}:${fixtureDigest}:${configHash}`, 'utf8')
    .digest('hex')

  return runRecordSchema.parse({
    manifest: { sources: manifestSources },
    fixtures: { sources: fixtureSources },
    pipelineConfig: config,
    pipelineConfigHash: configHash,
    corpusBuildHash,
    includedDocumentIds,
  })
}
