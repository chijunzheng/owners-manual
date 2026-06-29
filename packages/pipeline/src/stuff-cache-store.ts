/**
 * The stuffing-arm cache RECORD persistence (#44) — the pure half.
 *
 * {@link provisionStuffCache} reuses an unexpired cache only if it can recall the
 * one it last created; that note is round-tripped through a small gitignored JSON
 * file (`corpus/stuff-cache.json`) so a later run reuses the live cache instead of
 * recreating it (and re-billing the ~900K-token prefix). This module owns the PURE
 * serialize/parse over a zod schema — kept out of the file-I/O live binding
 * (`live/stuff-cache-file.ts`) so the parse is unit-tested offline: round-trip,
 * absent→undefined, malformed→throw. Fail-loud on a malformed store: a corrupt
 * record must throw, never silently reuse a bad cache name or recreate without
 * notice.
 *
 * The schema is STRICT and mirrors {@link StuffCacheRecord} field-for-field (the
 * canonical type stays in stuff-cache.ts — one source of truth); an unknown extra
 * key throws so a shape drift is caught rather than ignored.
 */

import { z } from 'zod'

import { type StuffCacheRecord } from './stuff-cache.js'

export { type StuffCacheRecord } from './stuff-cache.js'

/** The persisted cache-record shape. Strict: the on-disk shape is pinned (ADR 0004). */
const stuffCacheRecordSchema = z
  .object({
    name: z.string().min(1),
    corpusBuildHash: z.string().min(1),
    model: z.string().min(1),
    location: z.string().min(1).optional(),
    expiresAtMs: z.number().finite(),
  })
  .strict()

/** Serialize a cache record to the human-readable JSON the store file holds. */
export function serializeStuffCacheRecord(record: StuffCacheRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`
}

/**
 * Parse the cache-store file content into a record. An absent file (undefined) or
 * an empty/whitespace file (a never-written store) yields `undefined` — the
 * documented "no prior cache" state, which {@link provisionStuffCache} treats as
 * recreate. Malformed JSON or a shape mismatch THROWS (fail loud) rather than
 * silently discarding a corrupt record.
 */
export function parseStuffCacheStore(text: string | undefined): StuffCacheRecord | undefined {
  if (text === undefined || text.trim().length === 0) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`stuff cache store is not valid JSON: ${reason}`)
  }
  return stuffCacheRecordSchema.parse(parsed)
}
