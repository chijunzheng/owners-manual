/**
 * Manifest verification engine.
 *
 * Given a manifest and a {@link ByteSource}, recompute each source's checksum
 * over its normalized bytes and compare to what the manifest recorded. The
 * engine is transport-agnostic on purpose: the CLI injects a curl source for a
 * live rebuild and a disk source for re-verifying a clean checkout, while tests
 * inject in-memory bytes so CI never touches the network.
 *
 * Failures are values, not exceptions — a fetch error or a checksum mismatch on
 * one source is recorded and the run continues, so the report shows every
 * problem at once. The caller maps `report.ok === false` to a nonzero exit.
 */

import { checksum } from './hash.js'
import type { Checksum } from './hash.js'
import type { Manifest, ManifestSource } from './manifest/schema.js'

/** Supplies the raw bytes for a source (HTTP, disk, or in-memory in tests). */
export interface ByteSource {
  read(source: ManifestSource): Promise<Uint8Array>
}

/** Per-source verification outcome. */
export type SourceResult =
  | { readonly status: 'ok'; readonly source: ManifestSource; readonly actual: Checksum }
  | {
      readonly status: 'mismatch'
      readonly source: ManifestSource
      readonly expected: Checksum
      readonly actual: Checksum
    }
  | { readonly status: 'error'; readonly source: ManifestSource; readonly message: string }

/** Aggregate result of verifying an entire manifest. */
export interface VerifyReport {
  readonly ok: boolean
  readonly okCount: number
  readonly failedCount: number
  readonly results: readonly SourceResult[]
}

/** Tallies per-source results into a {@link VerifyReport}. Shared by verify and rebuild. */
export function summarize(results: readonly SourceResult[]): VerifyReport {
  const okCount = results.filter((r) => r.status === 'ok').length
  const failedCount = results.length - okCount
  return { ok: failedCount === 0, okCount, failedCount, results }
}

function expectedChecksum(source: ManifestSource): Checksum {
  return { sha256: source.sha256, bytes: source.bytes }
}

async function verifySource(source: ManifestSource, bytes: ByteSource): Promise<SourceResult> {
  let raw: Uint8Array
  try {
    raw = await bytes.read(source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'error', source, message }
  }

  const actual = checksum(raw, source.normalization)
  const expected = expectedChecksum(source)
  if (actual.sha256 === expected.sha256 && actual.bytes === expected.bytes) {
    return { status: 'ok', source, actual }
  }
  return { status: 'mismatch', source, expected, actual }
}

/**
 * Verifies every source in the manifest against the byte source, preserving
 * source order. Resolves to a {@link VerifyReport}; never rejects on a
 * per-source failure.
 */
export async function verifyManifest(
  manifest: Manifest,
  bytes: ByteSource,
): Promise<VerifyReport> {
  const results = await Promise.all(manifest.sources.map((source) => verifySource(source, bytes)))
  return summarize(results)
}
