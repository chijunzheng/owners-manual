/**
 * The designed-fixture registry: the six synthetic documents under
 * corpus/fixtures/, the prose parser each needs, and the fixture-design entries
 * each one carries.
 *
 * Designed fixtures (CONTEXT.md) are synthetic declarations, rules, policies, and
 * a lease authored to plant specific teachable conflicts (deductible chargeback,
 * a rule inconsistent with the declaration, RTA-void lease clauses). They are
 * authored as classless prose HTML5 and parsed by the SAME deterministic `prose`
 * family as the LTB guidelines (ADR 0004), so every fixture gets citable paths
 * exactly like the fetched corpus and travels the identical ingestion pipeline.
 *
 * They differ from {@link CORPUS_SOURCES} in one way that shapes this module:
 * fixtures are COMMITTED to the repo, not fetched. They carry no Crown-copyright
 * text, are present in a clean checkout (corpus/fixtures/ is not gitignored), and
 * have no manifest checksum entry. Registering them in CORPUS_SOURCES would break
 * that registry's manifest-mirror invariant (its `id`/`file` mirror the committed
 * corpus manifest, which fixtures are absent from), so they live here instead.
 * The practical payoff: the fixture intrinsic gate is network-free and runs on
 * every PR, like the golden extraction set, never skipping for absent bytes.
 *
 * Each fixture cross-references the {@link FixtureDesignId}s it carries
 * (FIXTURE-DESIGN.md), so a fixture tree is tied back to the planted conflicts
 * golden/adversarial eval cases reference by id — issue #12 acceptance criterion
 * 4. The two registries here are exhaustive against the design note in both
 * directions (every entry referenced exists; every entry exists is referenced),
 * which the registry tests enforce.
 */

import { parseProse } from './prose-parser.js'
import type { ParsedDocument } from './parsed-document.js'
import type { SourceFamily } from './sources.js'

/**
 * The fixture-design entry ids declared in FIXTURE-DESIGN.md. Kept as a typed
 * constant so a fixture's `designEntries` can be checked against the source of
 * truth (the design note) by the registry tests, and so an eval case can refer to
 * a conflict by a name TypeScript knows.
 */
export const FIXTURE_DESIGN_IDS = [
  'INS-01',
  'INS-02',
  'INS-03',
  'LEASE-01',
  'LEASE-02',
  'LEASE-03',
  'LEASE-04',
  'LEASE-05',
  'LEASE-06',
  'LEASE-07',
  'LEASE-08',
  'GOV-01',
  'GOV-02',
  'GOV-03',
  'GOV-04',
  'GOV-05',
  'GOV-06',
] as const

export type FixtureDesignId = (typeof FIXTURE_DESIGN_IDS)[number]

/** One registered designed fixture: its id, title, byte path, family, conflicts. */
export interface FixtureSource {
  /** The fixture id, namespaced `fixture-*` so it never collides with a manifest source id. */
  readonly id: string
  /** The document title used as the tree root label. */
  readonly title: string
  /** The byte path under corpus/fixtures, mirroring FIXTURE-DESIGN.md's layout. */
  readonly file: string
  /** Always `prose`: fixtures are classless prose HTML5 (ADR 0004). */
  readonly family: SourceFamily
  /** The fixture-design entries this fixture carries (acceptance criterion 4). */
  readonly designEntries: readonly FixtureDesignId[]
}

/**
 * The six committed fixtures and the conflicts each carries. The cross-references
 * follow FIXTURE-DESIGN.md: a conflict that lives in two instruments (a rule
 * contradicting the declaration; a deductible the master policy charges but the
 * declaration defines) is referenced by BOTH fixtures, because both trees must be
 * read to resolve it — that is exactly the hierarchy/fan-out the conflict teaches.
 */
export const FIXTURE_SOURCES: readonly FixtureSource[] = [
  {
    id: 'fixture-declaration',
    title: 'Declaration of Toronto Standard Condominium Corporation No. 9000 (Harbourview Terrace)',
    file: 'governing/declaration.html',
    family: 'prose',
    // Pet permission (GOV-01 baseline), BBQ permission (GOV-02), the chargeback
    // provision (INS-02), the lawful 10-day leasing baseline (GOV-06), and the
    // declaration pet provision that LEASE-01's void clause fans out to.
    designEntries: ['GOV-01', 'GOV-02', 'GOV-06', 'INS-02', 'LEASE-01'],
  },
  {
    id: 'fixture-rules',
    title: 'Rules of Toronto Standard Condominium Corporation No. 9000 (Harbourview Terrace)',
    file: 'governing/rules.html',
    family: 'prose',
    // Pet rule inconsistent with the declaration (GOV-01), the parking "fine"
    // (GOV-03), the six-month-minimum STR rule (GOV-05), the trespasser overreach
    // (GOV-06).
    designEntries: ['GOV-01', 'GOV-03', 'GOV-05', 'GOV-06'],
  },
  {
    id: 'fixture-management-policies',
    title: 'Resident Policies — Harbourview Terrace (TSCC 9000)',
    file: 'governing/management-policies.html',
    family: 'prose',
    // BBQ ban contradicting the declaration (GOV-02), the move-in fee without
    // authority (GOV-04), the STR restriction misattributed to the declaration
    // (GOV-05).
    designEntries: ['GOV-02', 'GOV-04', 'GOV-05'],
  },
  {
    id: 'fixture-master-policy',
    title: 'Certificate of Property and Liability Insurance — Master Policy (TSCC 9000)',
    file: 'insurance/master-policy.html',
    family: 'prose',
    // Insures the standard unit only and defers its definition to the absent
    // standard-unit by-law (INS-01); carries the $25,000 deductible the
    // declaration charges back (INS-02).
    designEntries: ['INS-01', 'INS-02'],
  },
  {
    id: 'fixture-unit-policy',
    title: 'Condominium Unit Owner’s Policy — Harbourview Terrace',
    file: 'insurance/unit-policy.html',
    family: 'prose',
    // No improvements/betterments rider (INS-01 owner-side exposure); excludes
    // sewer back-up with no endorsement (INS-03).
    designEntries: ['INS-01', 'INS-03'],
  },
  {
    id: 'fixture-lease',
    title: 'Residential Tenancy Agreement (Suite 1204, Harbourview Terrace)',
    file: 'tenancy/lease.html',
    family: 'prose',
    // Every lease conflict lives here (FIXTURE-DESIGN.md: "All in
    // tenancy/lease.html"), including the enforceable control pair LEASE-08.
    designEntries: [
      'LEASE-01',
      'LEASE-02',
      'LEASE-03',
      'LEASE-04',
      'LEASE-05',
      'LEASE-06',
      'LEASE-07',
      'LEASE-08',
    ],
  },
]

/** Looks up a registered fixture by id, or `undefined` if it is not registered. */
export function fixtureById(id: string): FixtureSource | undefined {
  return FIXTURE_SOURCES.find((source) => source.id === id)
}

/**
 * Parses a fixture's raw HTML through the prose parser, keyed by fixture id.
 * Throws for an unregistered id rather than guessing, so a typo can never route a
 * non-fixture document through the fixture path.
 */
export function parseFixture(id: string, html: string): ParsedDocument {
  const source = fixtureById(id)
  if (!source) throw new Error(`Cannot parse unknown fixture id "${id}"`)
  return parseProse({ documentId: source.id, title: source.title, html })
}
