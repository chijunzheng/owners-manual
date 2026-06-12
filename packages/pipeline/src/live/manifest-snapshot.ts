/**
 * Live wrapper: read and parse the committed corpus manifest, then extract the
 * snapshot rows for the statute sources a build measured (fixtures carry no
 * manifest entry — ADR 0004 / fixtures.ts — so only corpus ids are pinned here).
 */

import { readFile } from 'node:fs/promises'

import { extractManifestSnapshot } from '../manifest-snapshot-util.js'
import { type ManifestSnapshotSource } from '../run-record.js'

/** Load the manifest at `path` and extract snapshot rows for `sourceIds`. */
export async function loadManifestSnapshot(
  path: string,
  sourceIds: readonly string[],
): Promise<ManifestSnapshotSource[]> {
  const manifest = JSON.parse(await readFile(path, 'utf8')) as object
  return extractManifestSnapshot(manifest, sourceIds)
}
