import { describe, expect, it } from 'vitest'

import {
  parseStuffCacheStore,
  serializeStuffCacheRecord,
  type StuffCacheRecord,
} from './stuff-cache-store.js'

// The stuffing-arm cache RECORD persistence (#44). The record is round-tripped
// through a gitignored JSON file so a later run reuses an unexpired cache instead
// of recreating it. The serialize/parse is PURE (a zod schema over the persisted
// shape) and unit-tested here — round-trip, malformed→throw, absent→undefined; the
// file I/O is a thin live binding (`live/stuff-cache-file.ts`), not vitest-tested.

const HASH = 'a'.repeat(64)

const record: StuffCacheRecord = {
  name: 'projects/p/locations/global/cachedContents/abc',
  corpusBuildHash: HASH,
  model: 'gemini-2.5-pro',
  expiresAtMs: 1_000_000 + 86_400_000,
}

const recordWithLocation: StuffCacheRecord = {
  ...record,
  name: 'projects/p/locations/us-central1/cachedContents/abc',
  location: 'us-central1',
}

describe('serialize/parse round-trip', () => {
  it('parses back exactly what was serialized (no location)', () => {
    expect(parseStuffCacheStore(serializeStuffCacheRecord(record))).toEqual(record)
  })

  it('round-trips the optional Vertex location (region-scoped caches)', () => {
    expect(parseStuffCacheStore(serializeStuffCacheRecord(recordWithLocation))).toEqual(
      recordWithLocation,
    )
  })

  it('serializes to human-readable JSON (a gitignored file a human may inspect)', () => {
    const text = serializeStuffCacheRecord(record)
    expect(text).toContain(HASH)
    expect(JSON.parse(text)).toEqual(record)
  })
})

describe('absent record → undefined', () => {
  it('returns undefined for an absent file (undefined text)', () => {
    expect(parseStuffCacheStore(undefined)).toBeUndefined()
  })

  it('returns undefined for an empty/whitespace file (never-written store)', () => {
    expect(parseStuffCacheStore('')).toBeUndefined()
    expect(parseStuffCacheStore('   \n')).toBeUndefined()
  })
})

describe('malformed store → throw (fail loud, never a silent bad reuse)', () => {
  it('throws on non-JSON text', () => {
    expect(() => parseStuffCacheStore('{ not json')).toThrow()
  })

  it('throws when a required field is missing', () => {
    const withoutName: Record<string, unknown> = { ...record }
    delete withoutName.name
    expect(() => parseStuffCacheStore(JSON.stringify(withoutName))).toThrow()
  })

  it('throws when a field has the wrong type', () => {
    expect(() => parseStuffCacheStore(JSON.stringify({ ...record, expiresAtMs: 'soon' }))).toThrow()
  })

  it('throws on an unknown extra field (strict — the shape is pinned)', () => {
    expect(() => parseStuffCacheStore(JSON.stringify({ ...record, extra: true }))).toThrow()
  })
})
