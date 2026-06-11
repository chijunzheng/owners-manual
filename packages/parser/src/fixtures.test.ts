import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  FIXTURE_DESIGN_IDS,
  FIXTURE_SOURCES,
  fixtureById,
  parseFixture,
  type FixtureSource,
} from './fixtures.js'

/**
 * The designed-fixture registry (issue #12, fixtures half). The six synthetic
 * documents under corpus/fixtures/ are authored as classless prose HTML5 and
 * travel the SAME prose parser as the LTB guidelines (ADR 0004), so each gets
 * citable paths exactly like the fetched corpus. Unlike the fetched sources they
 * are COMMITTED to the repo (present in a clean checkout, not gitignored, no
 * Crown-copyright text and no manifest checksum entry), so this registry is
 * separate from CORPUS_SOURCES — registering them there would break the
 * manifest-mirror invariant — and the fixture intrinsic gate runs network-free
 * on every PR, like the golden extraction set.
 *
 * Every fixture cross-references the fixture-design entries it carries
 * (FIXTURE-DESIGN.md), which is acceptance criterion 4: a fixture tree is tied
 * back to the planted conflicts golden/adversarial eval cases reference by ID.
 */

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURES_ROOT = join(here, '..', '..', '..', 'corpus', 'fixtures')

function readFixture(source: FixtureSource): string {
  return readFileSync(join(FIXTURES_ROOT, source.file), 'utf8')
}

describe('FIXTURE_SOURCES registry', () => {
  it('registers all six designed fixtures across the three corpora', () => {
    expect(FIXTURE_SOURCES).toHaveLength(6)
    const ids = FIXTURE_SOURCES.map((s) => s.id)
    for (const id of [
      'fixture-declaration',
      'fixture-rules',
      'fixture-management-policies',
      'fixture-master-policy',
      'fixture-unit-policy',
      'fixture-lease',
    ]) {
      expect(ids).toContain(id)
    }
  })

  it('classifies every fixture as the prose family (same parser as the guidelines)', () => {
    for (const source of FIXTURE_SOURCES) {
      expect(source.family).toBe('prose')
    }
  })

  it('points each fixture at its committed byte path under corpus/fixtures', () => {
    expect(fixtureById('fixture-declaration')!.file).toBe('governing/declaration.html')
    expect(fixtureById('fixture-master-policy')!.file).toBe('insurance/master-policy.html')
    expect(fixtureById('fixture-lease')!.file).toBe('tenancy/lease.html')
  })

  it('fixtureById returns undefined for an unknown id', () => {
    expect(fixtureById('does-not-exist')).toBeUndefined()
  })

  it('carries no manifest checksum entry concern: fixture ids are distinct from manifest source ids', () => {
    // Fixtures are committed, not fetched — their ids are namespaced with a
    // "fixture-" prefix so they can never collide with a manifest source id.
    for (const source of FIXTURE_SOURCES) {
      expect(source.id.startsWith('fixture-')).toBe(true)
    }
  })
})

describe('parseFixture dispatch', () => {
  it('parses a fixture through the prose parser under its registered id and title', () => {
    const html = readFixture(fixtureById('fixture-rules')!)
    const parsed = parseFixture('fixture-rules', html)
    expect(parsed.tree.documentId).toBe('fixture-rules')
    expect(parsed.tree.kind).toBe('document')
    expect(parsed.tree.children.some((n) => n.kind === 'section')).toBe(true)
  })

  it('throws for an unknown fixture id rather than guessing', () => {
    expect(() => parseFixture('nope', '<p>x</p>')).toThrow(/unknown fixture/i)
  })
})

describe('fixture-design cross-reference (acceptance criterion 4)', () => {
  it('every design id a fixture references is a real entry in FIXTURE-DESIGN.md', () => {
    for (const source of FIXTURE_SOURCES) {
      expect(source.designEntries.length).toBeGreaterThan(0)
      for (const entry of source.designEntries) {
        expect(FIXTURE_DESIGN_IDS).toContain(entry)
      }
    }
  })

  it('every fixture-design entry is carried by at least one fixture (no orphan conflict)', () => {
    const referenced = new Set(FIXTURE_SOURCES.flatMap((s) => s.designEntries))
    for (const id of FIXTURE_DESIGN_IDS) {
      expect(referenced).toContain(id)
    }
  })

  it('FIXTURE_DESIGN_IDS is exactly the entries declared in FIXTURE-DESIGN.md', () => {
    const designNote = readFileSync(join(FIXTURES_ROOT, 'FIXTURE-DESIGN.md'), 'utf8')
    const declared = [...designNote.matchAll(/^\*\*((?:INS|LEASE|GOV)-\d+)/gm)].map((m) => m[1])
    expect(new Set(FIXTURE_DESIGN_IDS)).toEqual(new Set(declared))
    // No duplicate ids in the registry constant.
    expect(FIXTURE_DESIGN_IDS.length).toBe(new Set(FIXTURE_DESIGN_IDS).size)
  })

  it('routes the lease conflicts to the lease fixture and the pet hierarchy to declaration + rules', () => {
    expect(fixtureById('fixture-lease')!.designEntries).toEqual(
      expect.arrayContaining(['LEASE-01', 'LEASE-08']),
    )
    expect(fixtureById('fixture-declaration')!.designEntries).toContain('GOV-01')
    expect(fixtureById('fixture-rules')!.designEntries).toContain('GOV-01')
  })
})
