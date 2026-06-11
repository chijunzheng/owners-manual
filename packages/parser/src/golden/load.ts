/**
 * Loader and schema for the golden extraction set.
 *
 * A golden item is a committed JSON record pinning the hand-blessed parse of one
 * hard RTA section: which short source excerpt it covers, the expected document
 * subtree, the expected text sidecar, and — mandatory — its provenance and the
 * King's-Printer licence note for the excerpt (CONTEXT.md: an item nobody can
 * trace doesn't ship). The schema is strict so a malformed item fails loudly
 * rather than silently weakening the test.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { documentTreeSchema } from '@owners-manual/core'
import { z } from 'zod'

/** The hard-section classes the extraction set covers. */
export const GOLDEN_CATEGORIES = ['definitions', 'repealed-marker', 'embedded-table'] as const

export type GoldenCategory = (typeof GOLDEN_CATEGORIES)[number]

const goldenItemSchema = z
  .object({
    /** Stable id referenced by failures (e.g. "rta-s2-definitions"). */
    id: z.string().min(1),
    /** Which hard-section class this item exercises. */
    category: z.enum(GOLDEN_CATEGORIES),
    /** Why this item exists and where the excerpt came from (traceability). */
    provenance: z.string().min(1),
    /** The licence note for the committed source excerpt. */
    licence: z.string().min(1),
    /** The excerpt file, relative to the items directory. */
    sourceFile: z.string().min(1),
    /** The document id and title the parse is run under. */
    documentId: z.string().min(1),
    title: z.string().min(1),
    /** The hand-blessed expected tree (validated against the #7 schema). */
    expectedTree: documentTreeSchema,
    /** The hand-blessed expected text sidecar: pathKey → operative text. */
    expectedText: z.record(z.string(), z.string()),
  })
  .strict()

export type GoldenItem = z.infer<typeof goldenItemSchema>

/** Parses and validates one golden item from JSON. */
export function parseGoldenItem(value: unknown): GoldenItem {
  return goldenItemSchema.parse(value)
}

/**
 * Loads every `*.json` golden item from `itemsDir`, sorted by id for a stable,
 * deterministic test order. Throws on the first malformed item.
 */
export function loadGoldenExtractionSet(itemsDir: string): GoldenItem[] {
  const files = readdirSync(itemsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
  return files.map((name) => {
    const raw: unknown = JSON.parse(readFileSync(join(itemsDir, name), 'utf8'))
    try {
      return parseGoldenItem(raw)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Malformed golden extraction item ${name}: ${reason}`)
    }
  })
}
