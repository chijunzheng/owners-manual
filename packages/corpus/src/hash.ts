/**
 * Content hashing for corpus sources. SHA-256 over the *normalized* bytes is
 * the corpus-versioning primitive: the manifest pins each source by digest, and
 * the verify recomputes it to prove a byte-identical rebuild.
 */

import { createHash } from 'node:crypto'

import { normalizeBytes } from './normalize.js'
import type { NormalizationPolicy } from './manifest/schema.js'

/** Lowercase hex SHA-256 of the given bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The recorded fingerprint of a source: digest plus byte length. */
export interface Checksum {
  readonly sha256: string
  readonly bytes: number
}

/**
 * Normalizes raw bytes per the policy, then reports the digest and byte length
 * of the normalized content — exactly what the manifest stores and the verify
 * compares against.
 */
export function checksum(raw: Uint8Array, policy: NormalizationPolicy): Checksum {
  const normalized = normalizeBytes(raw, policy)
  return {
    sha256: sha256Hex(normalized),
    bytes: normalized.length,
  }
}
