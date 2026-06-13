/**
 * Pure extraction of the manifest snapshot the run record pins (AC4): pluck
 * id/checksum/consolidation-date for exactly the sources a build measured. Kept
 * separate from the file-reading live helper so it is unit-tested offline.
 */

import { type ManifestSnapshotSource } from './run-record.js'

interface ManifestShape {
  readonly sources?: ReadonlyArray<{
    readonly id?: unknown
    readonly sha256?: unknown
    readonly consolidationDate?: unknown
  }>
}

/**
 * Extract the snapshot rows for `sourceIds` from a parsed manifest, in the
 * requested order. Throws if any requested id is absent — a build that cannot
 * pin a source's checksum is unreproducible.
 */
export function extractManifestSnapshot(
  manifest: ManifestShape,
  sourceIds: readonly string[],
): ManifestSnapshotSource[] {
  const byId = new Map((manifest.sources ?? []).map((source) => [String(source.id), source]))
  return sourceIds.map((id) => {
    const source = byId.get(id)
    if (!source) throw new Error(`manifest is missing requested source "${id}"`)
    return {
      id,
      sha256: String(source.sha256),
      consolidationDate: String(source.consolidationDate),
    }
  })
}
