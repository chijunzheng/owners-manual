/**
 * The live stuffing-arm cache-record file binding (#44): wires the PURE
 * serialize/parse (`stuff-cache-store.ts`) to a small gitignored JSON file
 * (`corpus/stuff-cache.json`) as the `loadRecord` / `saveRecord` seam
 * {@link resolveStuffCachedContentName} threads through. Persisting the last
 * created cache lets a later run reuse an unexpired cache instead of recreating it
 * (and re-billing the ~900K-token prefix).
 *
 * Synchronous fs by design: the seam is synchronous (`() => record | undefined`)
 * and the resolve happens once at service startup, so blocking reads/writes are
 * appropriate — no async ceremony for a single small file. Live by design and not
 * unit-tested: the parse/serialize logic (round-trip, malformed→throw,
 * absent→undefined) is covered against strings in `stuff-cache-store.test.ts`;
 * this only adapts it to one file path. A missing file is the "no prior cache"
 * state (undefined); a malformed file throws (fail loud, never a silent bad reuse).
 */

import { readFileSync, writeFileSync } from 'node:fs'

import {
  parseStuffCacheStore,
  serializeStuffCacheRecord,
  type StuffCacheRecord,
} from '../stuff-cache-store.js'

export interface StuffCacheFileStore {
  /** Load the last persisted record, or undefined when the file is absent. */
  readonly loadRecord: () => StuffCacheRecord | undefined
  /** Persist a freshly created record so the next run can reuse it. */
  readonly saveRecord: (record: StuffCacheRecord) => void
}

/** Read the file at `path`, mapping an absent file (ENOENT) to undefined text. */
function readTextOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Build the file-backed cache-record store at `path` (e.g. `corpus/stuff-cache.json`). */
export function createStuffCacheFileStore(path: string): StuffCacheFileStore {
  return {
    loadRecord: () => parseStuffCacheStore(readTextOrUndefined(path)),
    saveRecord: (record) => {
      writeFileSync(path, serializeStuffCacheRecord(record), 'utf8')
    },
  }
}
