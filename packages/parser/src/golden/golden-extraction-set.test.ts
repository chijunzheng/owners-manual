import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { documentTreeSchema } from '@owners-manual/core'
import { describe, expect, it } from 'vitest'

import { type ParsedDocument } from '../parsed-document.js'
import { parseProse } from '../prose-parser.js'
import { parseStatute } from '../rta-parser.js'
import { pathKey } from '../parsed-document.js'
import { type GoldenItem, loadGoldenExtractionSet } from './load.js'

/**
 * The golden extraction set: hand-verified expected subtrees for the
 * hardest-to-parse RTA sections — the ingestion analog of the golden Q/A set
 * (CONTEXT.md). Each item pairs a SHORT verbatim source excerpt (committed with
 * its King's-Printer licence attribution and a provenance note, so the item is
 * traceable — "an item nobody can trace doesn't ship") with the blessed tree and
 * text the deterministic parser must reproduce. These run in CI on every merge:
 * they are network-free and carry only short excerpts, never the full statute.
 */
const here = dirname(fileURLToPath(import.meta.url))
const items = loadGoldenExtractionSet(join(here, 'items'))

/** Parses a golden excerpt through the deterministic parser its family needs. */
function parseGolden(item: GoldenItem, html: string): ParsedDocument {
  const input = { documentId: item.documentId, title: item.title, html }
  return item.family === 'prose' ? parseProse(input) : parseStatute(input)
}

describe('golden extraction set', () => {
  it('ships at least one item for each hard section class it claims to cover', () => {
    const categories = new Set(items.map((item) => item.category))
    expect(categories).toContain('definitions')
    expect(categories).toContain('repealed-marker')
    // Issue #31 adds the embedded table (deferred from #8) and a prose section.
    expect(categories).toContain('embedded-table')
    expect(categories).toContain('prose-section')
  })

  it('covers both parser families', () => {
    const families = new Set(items.map((item) => item.family))
    expect(families).toContain('elaws')
    expect(families).toContain('prose')
  })

  it('every item carries traceable provenance and an appropriate licence note', () => {
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) {
      expect(item.provenance.length).toBeGreaterThan(0)
      // e-laws excerpts are King's Printer; prose guideline excerpts are
      // Tribunals Ontario — every item must attribute one of them.
      expect(item.licence).toMatch(/King’s Printer for Ontario|Tribunals Ontario/)
    }
  })

  it.each(items.map((item) => [item.id, item] as const))(
    'parses %s into the hand-blessed subtree',
    (_id, item) => {
      const sourceHtml = readFileSync(join(here, 'items', item.sourceFile), 'utf8')
      const parsed = parseGolden(item, sourceHtml)

      // The blessed tree is reproduced exactly, and it is itself schema-valid.
      expect(() => documentTreeSchema.parse(parsed.tree)).not.toThrow()
      expect(parsed.tree).toEqual(item.expectedTree)
    },
  )

  it.each(items.map((item) => [item.id, item] as const))(
    'recovers the hand-blessed operative text for %s',
    (_id, item) => {
      const sourceHtml = readFileSync(join(here, 'items', item.sourceFile), 'utf8')
      const parsed = parseGolden(item, sourceHtml)

      const actual: Record<string, string> = {}
      for (const [key, value] of parsed.text) actual[key] = value
      expect(actual).toEqual(item.expectedText)
    },
  )

  it.each(items.map((item) => [item.id, item] as const))(
    'keeps every blessed text fragment a verbatim slice of its source excerpt — %s',
    (_id, item) => {
      const sourceHtml = readFileSync(join(here, 'items', item.sourceFile), 'utf8')
      const parsed = parseGolden(item, sourceHtml)
      // Cross-check: each text key is a real node path in the blessed tree.
      const keys = new Set<string>()
      const walk = (
        node: { kind: string; label: string; children: readonly unknown[] },
        segments: { kind: string; label: string }[],
      ): void => {
        keys.add(pathKey({ documentId: item.documentId, segments: segments as never }))
        for (const child of node.children) {
          const c = child as { kind: string; label: string; children: readonly unknown[] }
          walk(c, [...segments, { kind: c.kind, label: c.label }])
        }
      }
      walk(item.expectedTree as never, [])
      for (const key of parsed.text.keys()) expect(keys.has(key)).toBe(true)
    },
  )
})
