/**
 * Byte-normalization applied before hashing and before writing to corpus/raw/.
 *
 * The ontario.ca and tribunalsontario.ca CDN injects a per-request WAF /
 * bot-detection script (random `__uzdbm_*` session tokens) into every page, so
 * the same statute served twice is not byte-identical. That injected line is
 * not part of the legal source, so the `strip-waf` policy removes it; with it
 * gone the documents reproduce byte-for-byte. When a source declares a policy,
 * both the fetch and the verify apply it, so "byte-identical rebuild" means
 * "identical after the documented, deterministic normalization" — recorded per
 * source so the transform is auditable, never hidden. A source that cannot be
 * made stable even with normalization is a stop condition, not a silently
 * flaky verify.
 */

import type { NormalizationPolicy } from './manifest/schema.js'

const CR = 0x0d
const LF = 0x0a

/**
 * Marker identifying the CDN's volatile WAF script line. The first per-request
 * token is `__uzdbm_1`; any line carrying it is injected noise, not source.
 */
const WAF_MARKER = '__uzdbm_1'

/**
 * Collapses CRLF and lone-CR line endings to LF. Operates on a fresh buffer;
 * the input is never mutated.
 */
function crlfToLf(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length)
  let length = 0
  for (let i = 0; i < input.length; i += 1) {
    const byte = input[i]
    if (byte === CR) {
      out[length] = LF
      length += 1
      // Swallow the LF of a CRLF pair so it becomes a single LF.
      if (input[i + 1] === LF) {
        i += 1
      }
    } else {
      out[length] = byte as number
      length += 1
    }
  }
  return out.subarray(0, length)
}

const MARKER_BYTES = new TextEncoder().encode(WAF_MARKER)

/** True if `line` (a byte slice, no trailing LF) contains the WAF marker. */
function lineHasMarker(line: Uint8Array): boolean {
  if (line.length < MARKER_BYTES.length) {
    return false
  }
  const limit = line.length - MARKER_BYTES.length
  for (let start = 0; start <= limit; start += 1) {
    let matched = true
    for (let j = 0; j < MARKER_BYTES.length; j += 1) {
      if (line[start + j] !== MARKER_BYTES[j]) {
        matched = false
        break
      }
    }
    if (matched) {
      return true
    }
  }
  return false
}

/**
 * Removes whole lines containing the WAF marker, preserving every other byte
 * including the original LF structure and any trailing-newline state. Operates
 * at the byte level so non-ASCII content round-trips untouched; the input is
 * never mutated.
 */
function stripWaf(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length)
  let length = 0
  let lineStart = 0

  const copyLineIfKept = (end: number, includeNewline: boolean) => {
    const line = input.subarray(lineStart, end)
    if (lineHasMarker(line)) {
      return
    }
    out.set(line, length)
    length += line.length
    if (includeNewline) {
      out[length] = LF
      length += 1
    }
  }

  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === LF) {
      copyLineIfKept(i, true)
      lineStart = i + 1
    }
  }
  // Trailing line with no terminating LF.
  if (lineStart < input.length) {
    copyLineIfKept(input.length, false)
  }

  return out.subarray(0, length)
}

/**
 * Applies the manifest's documented normalization policy to raw bytes,
 * returning a new buffer. "none" is the identity transform.
 */
export function normalizeBytes(input: Uint8Array, policy: NormalizationPolicy): Uint8Array {
  switch (policy) {
    case 'none':
      return input
    case 'strip-waf':
      return stripWaf(input)
    case 'crlf-to-lf':
      return crlfToLf(input)
  }
}
