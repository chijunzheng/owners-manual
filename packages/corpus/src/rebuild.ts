/**
 * Rebuild orchestration: fetch every source, verify its checksum against the
 * manifest, and write the verified bytes to corpus/raw/.
 *
 * The *normalized* bytes are what gets stored — the same bytes that were hashed
 * — so the on-disk corpus is byte-reproducible across fetches even though the
 * CDN injects per-request WAF noise into each raw response. (Normalization is
 * idempotent, so re-verifying the stored bytes from disk still matches.) A
 * source is only persisted if it verifies, so a drifted or failed fetch never
 * leaves corrupt bytes on disk. Like the verify engine, per-source failures are
 * recorded, not thrown, so one bad source neither hides the others nor blocks
 * writing the good ones. The CLI maps `report.ok === false` to a nonzero exit.
 */

import { checksum } from './hash.js'
import { normalizeBytes } from './normalize.js'
import { writeSource } from './storage.js'
import { summarize } from './verify.js'
import type { ManifestSource } from './manifest/schema.js'
import type { ByteSource, SourceResult, VerifyReport } from './verify.js'

async function rebuildSource(
  source: ManifestSource,
  bytes: ByteSource,
  rawRoot: string,
): Promise<SourceResult> {
  let raw: Uint8Array
  try {
    raw = await bytes.read(source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'error', source, message }
  }

  const normalized = normalizeBytes(raw, source.normalization)
  const actual = checksum(normalized, 'none')
  const expected = { sha256: source.sha256, bytes: source.bytes }
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    return { status: 'mismatch', source, expected, actual }
  }

  try {
    await writeSource(rawRoot, source, normalized)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 'error', source, message }
  }
  return { status: 'ok', source, actual }
}

/**
 * Fetches and verifies every source, writing verified bytes under `rawRoot`.
 * Resolves to a {@link VerifyReport} describing the run.
 */
export async function rebuild(
  manifest: { readonly sources: readonly ManifestSource[] },
  bytes: ByteSource,
  rawRoot: string,
): Promise<VerifyReport> {
  const results = await Promise.all(
    manifest.sources.map((source) => rebuildSource(source, bytes, rawRoot)),
  )
  return summarize(results)
}
