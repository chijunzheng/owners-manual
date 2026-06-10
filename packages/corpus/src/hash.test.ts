import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { checksum, sha256Hex } from './hash.js'

const enc = (s: string) => new TextEncoder().encode(s)

describe('sha256Hex', () => {
  it('matches a known SHA-256 vector (empty input)', () => {
    // Well-known SHA-256 of the empty string.
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('matches node:crypto for arbitrary content', () => {
    const bytes = enc('Residential Tenancies Act, 2006')
    const expected = createHash('sha256').update(bytes).digest('hex')
    expect(sha256Hex(bytes)).toBe(expected)
  })

  it('returns lowercase 64-char hex', () => {
    const digest = sha256Hex(enc('anything'))
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic across calls', () => {
    const bytes = enc('same input')
    expect(sha256Hex(bytes)).toBe(sha256Hex(bytes))
  })
})

describe('checksum', () => {
  it('reports the normalized digest and normalized byte length', () => {
    // CRLF content normalized to LF: 2 CRLF pairs drop 2 bytes.
    const result = checksum(enc('a\r\nb\r\n'), 'crlf-to-lf')
    expect(result.bytes).toBe(4) // "a\nb\n"
    expect(result.sha256).toBe(sha256Hex(enc('a\nb\n')))
  })

  it('with "none" reports the raw digest and raw length', () => {
    const raw = enc('a\r\nb\r\n')
    const result = checksum(raw, 'none')
    expect(result.bytes).toBe(raw.length)
    expect(result.sha256).toBe(sha256Hex(raw))
  })
})
