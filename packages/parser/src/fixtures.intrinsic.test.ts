import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { documentTreeSchema } from '@owners-manual/core'
import { describe, expect, it } from 'vitest'

import { checkCiteRoundTrip, checkProseCompleteness, checkTextFidelity } from './intrinsic.js'
import { FIXTURE_SOURCES, parseFixture, type FixtureSource } from './fixtures.js'

/**
 * The intrinsic asserts (completeness, round-trip, fidelity) over every COMMITTED
 * designed fixture — the fixtures half of issue #12. This is the network-free,
 * per-PR analogue of corpus-full.intrinsic.test.ts: the fixtures carry no
 * Crown-copyright text and are committed (not gitignored), so unlike the fetched
 * corpus they are always present in a clean CI checkout and never skip. Together
 * they bring the fourth corpus into schema-valid trees with citable paths
 * (acceptance criteria 1–3 for the fixture sources), and the design-entry
 * presence check ties each tree back to its fixture-design conflicts (criterion
 * 4 at the tree level: the planted text actually lands in a citable node).
 *
 * The prose completeness oracle adapts per ADR 0004: fixtures have no table of
 * contents, so they are graded against their heading outline, exactly as the LTB
 * guidelines are. Heading counts are pinned (hand-verified against the committed
 * fixture bytes); a fixture edit that adds or drops a heading shows up here as a
 * count mismatch, which is the point.
 */

/** Hand-verified shape of each fixture under its committed bytes. */
interface FixtureExpectation {
  /** Content-heading occurrence total (the `<h1>` title is excluded). */
  readonly headings: number
  /** Exact count of text-bearing (round-tripped) nodes. */
  readonly textNodes: number
}

const EXPECTATIONS: Readonly<Record<string, FixtureExpectation>> = {
  'fixture-declaration': { headings: 11, textNodes: 44 },
  'fixture-rules': { headings: 4, textNodes: 16 },
  'fixture-management-policies': { headings: 3, textNodes: 11 },
  'fixture-master-policy': { headings: 9, textNodes: 29 },
  'fixture-unit-policy': { headings: 6, textNodes: 23 },
  'fixture-lease': { headings: 10, textNodes: 25 },
}

const FIXTURES_ROOT = join(process.cwd(), 'corpus', 'fixtures')

function bytesPath(source: FixtureSource): string {
  return join(FIXTURES_ROOT, source.file)
}

/**
 * A short, verbatim slice of one planted conflict per design id. Asserting these
 * fragments occur in some citable node proves the fixture TREE — not just the raw
 * file — carries the conflict the design entry promises, which is what makes the
 * cross-reference load-bearing rather than a comment.
 */
const DESIGN_FRAGMENTS: Readonly<Record<string, { fixture: string; fragment: string }>> = {
  'INS-01': {
    fixture: 'fixture-master-policy',
    fragment: "governed by the corporation's standard unit by-law",
  },
  'INS-02': {
    fixture: 'fixture-declaration',
    fragment:
      'shall be liable for and shall reimburse the Corporation for the amount of the deductible',
  },
  'INS-03': {
    fixture: 'fixture-unit-policy',
    fragment: 'does not insure loss or damage caused by sewer back-up',
  },
  'LEASE-01': {
    fixture: 'fixture-lease',
    fragment: 'No pets of any kind are permitted in the Unit',
  },
  'LEASE-02': {
    fixture: 'fixture-lease',
    fragment: 'responsible for all damage and repairs of any kind',
  },
  'LEASE-03': { fixture: 'fixture-lease', fragment: 'voluntarily offers' },
  'LEASE-04': { fixture: 'fixture-lease', fragment: 'returns it in its original condition' },
  'LEASE-05': {
    fixture: 'fixture-lease',
    fragment: 'pay the first $100.00 of the cost of every repair',
  },
  'LEASE-06': { fixture: 'fixture-lease', fragment: 'sixty days' },
  'LEASE-07': { fixture: 'fixture-lease', fragment: 'shall bear no interest' },
  'LEASE-08': { fixture: 'fixture-lease', fragment: "tenant's liability insurance" },
  'GOV-01': { fixture: 'fixture-rules', fragment: 'exceeds ten kilograms' },
  'GOV-02': { fixture: 'fixture-management-policies', fragment: 'barbecues of every kind' },
  'GOV-03': { fixture: 'fixture-rules', fragment: 'fined the sum of one hundred dollars' },
  'GOV-04': {
    fixture: 'fixture-management-policies',
    fragment: 'non-refundable move-in administration charge of one hundred and fifty dollars',
  },
  'GOV-05': {
    fixture: 'fixture-management-policies',
    fragment: 'Declaration of the Corporation prohibits short-term',
  },
  'GOV-06': { fixture: 'fixture-rules', fragment: 'deemed to be a trespasser' },
}

describe('intrinsic asserts over the committed designed fixtures', () => {
  it('every fixture file is present in a clean checkout (committed, not gitignored)', () => {
    for (const source of FIXTURE_SOURCES) {
      expect(existsSync(bytesPath(source))).toBe(true)
    }
  })

  for (const source of FIXTURE_SOURCES) {
    const expectation = EXPECTATIONS[source.id]!

    describe(`${source.id} (${source.family})`, () => {
      const html = readFileSync(bytesPath(source), 'utf8')
      const parsed = () => parseFixture(source.id, html)

      it('produces a schema-valid document tree with citable paths', () => {
        const tree = parsed().tree
        expect(() => documentTreeSchema.parse(tree)).not.toThrow()
        expect(tree.documentId).toBe(source.id)
        expect(tree.children.some((n) => n.kind === 'section')).toBe(true)
      })

      it('completeness: every content heading lands in exactly one heading node', () => {
        const result = checkProseCompleteness(parsed(), html)
        expect(result.missing).toEqual([])
        expect(result.unexpected).toEqual([])
        expect(result.duplicated).toEqual([])
        expect(result.expected).toBe(expectation.headings)
        expect(result.parsed).toBe(expectation.headings)
        expect(result.ok).toBe(true)
      })

      it('round-trips every text-bearing node: path → lookup → identical text', () => {
        const result = checkCiteRoundTrip(parsed())
        expect(result.mismatches).toEqual([])
        expect(result.checked).toBe(expectation.textNodes)
        expect(result.ok).toBe(true)
      })

      it('recovers every provision verbatim from the source (text fidelity)', () => {
        const result = checkTextFidelity(parsed(), html)
        expect(result.unfaithful).toEqual([])
        expect(result.coverageRatio).toBe(1)
        expect(result.ok).toBe(true)
      })
    })
  }

  describe('design entries land in the fixture trees (criterion 4)', () => {
    const treeFor = (id: string) => {
      const source = FIXTURE_SOURCES.find((s) => s.id === id)!
      return parseFixture(id, readFileSync(bytesPath(source), 'utf8'))
    }

    it.each(Object.entries(DESIGN_FRAGMENTS))(
      '%s — its planted conflict is carried by a citable node',
      (designId, { fixture, fragment }) => {
        // The fixture that registers this design id must be the one that carries it.
        const source = FIXTURE_SOURCES.find((s) => s.id === fixture)!
        expect(source.designEntries).toContain(designId)

        const parsed = treeFor(fixture)
        const texts = [...parsed.text.values()]
        expect(texts.some((text) => text.includes(fragment))).toBe(true)
      },
    )
  })
})
