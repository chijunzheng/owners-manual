import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { documentTreeSchema } from '@owners-manual/core'
import { describe, expect, it } from 'vitest'

import { fixtureById, parseFixture } from '../fixtures.js'
import { pathKey } from '../parsed-document.js'
import { loadGoldenExtractionSet, type GoldenItem } from './load.js'

/**
 * The golden extraction set for the DESIGNED FIXTURES (issue #12, fixtures half).
 *
 * A fixture's hardest section is a planted conflict nested under an article
 * heading — the same `<h2>` → `<h3>` → clause fold the LTB-guideline golden item
 * exercises, but on a synthetic document whose ground truth is known BY
 * CONSTRUCTION (CONTEXT.md: "golden-set answers over it are ground truth by
 * construction"). These items pin the exact hand-blessed subtree of a conflict so
 * a parser regression that mis-nests or drops a planted clause fails loudly, the
 * same protection the statute extraction set gives the hardest RTA sections.
 *
 * They live in a SEPARATE directory and test from the fetched-source golden set
 * because their provenance is different in kind: a fixture carries no Crown /
 * Tribunals copyright, so its licence note records synthetic authorship ("ground
 * truth by construction") rather than a King's-Printer attribution. Keeping them
 * apart leaves the fetched-source golden gate's licence invariant strict while
 * still extending the extraction set to the new hardest sections.
 */
const here = dirname(fileURLToPath(import.meta.url))
const itemsDir = join(here, 'fixture-items')
const items = loadGoldenExtractionSet(itemsDir)

function parse(item: GoldenItem, html: string) {
  return parseFixture(item.documentId, html)
}

describe('fixture golden extraction set', () => {
  it('ships at least one hand-blessed fixture subtree', () => {
    expect(items.length).toBeGreaterThan(0)
  })

  it('every item is a prose-section parsed through the fixture (prose) family', () => {
    for (const item of items) {
      expect(item.category).toBe('prose-section')
      expect(item.family).toBe('prose')
      expect(item.documentId.startsWith('fixture-')).toBe(true)
    }
  })

  it('every item declares ground-truth-by-construction provenance (no Crown/Tribunals licence)', () => {
    for (const item of items) {
      expect(item.provenance.length).toBeGreaterThan(0)
      // Fixtures are synthetic: their licence records authorship, not a
      // King's-Printer / Tribunals attribution.
      expect(item.licence).toMatch(/ground truth by construction|synthetic/i)
      expect(item.licence).not.toMatch(/King’s Printer for Ontario|Tribunals Ontario/)
    }
  })

  it('references a fixture-design entry id, tying the item to a planted conflict', () => {
    for (const item of items) {
      expect(item.provenance).toMatch(/(?:INS|LEASE|GOV)-\d+/)
    }
  })

  it('every blessed excerpt block is a verbatim slice of the committed fixture', () => {
    // The item is only "ground truth by construction" if its excerpt is the
    // fixture's own bytes, not a divergent copy. Each <p>/heading block in the
    // excerpt must occur verbatim in the committed fixture file the item names.
    const fixturesRoot = join(here, '..', '..', '..', '..', 'corpus', 'fixtures')
    for (const item of items) {
      const source = fixtureById(item.documentId)!
      const fixtureHtml = readFileSync(join(fixturesRoot, source.file), 'utf8')
      const excerpt = readFileSync(join(itemsDir, item.sourceFile), 'utf8')
      const blocks = excerpt.match(/<(?:p|h[1-6])>[\s\S]*?<\/(?:p|h[1-6])>/g) ?? []
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks) {
        expect(fixtureHtml).toContain(block)
      }
    }
  })

  it.each(items.map((item) => [item.id, item] as const))(
    'parses %s into the hand-blessed subtree',
    (_id, item) => {
      const html = readFileSync(join(itemsDir, item.sourceFile), 'utf8')
      const parsed = parse(item, html)
      expect(() => documentTreeSchema.parse(parsed.tree)).not.toThrow()
      expect(parsed.tree).toEqual(item.expectedTree)
    },
  )

  it.each(items.map((item) => [item.id, item] as const))(
    'recovers the hand-blessed operative text for %s',
    (_id, item) => {
      const html = readFileSync(join(itemsDir, item.sourceFile), 'utf8')
      const parsed = parse(item, html)
      const actual: Record<string, string> = {}
      for (const [key, value] of parsed.text) actual[key] = value
      expect(actual).toEqual(item.expectedText)
    },
  )

  it.each(items.map((item) => [item.id, item] as const))(
    'keeps every blessed text fragment addressable by a real node path — %s',
    (_id, item) => {
      const html = readFileSync(join(itemsDir, item.sourceFile), 'utf8')
      const parsed = parse(item, html)
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
