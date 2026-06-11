/**
 * The corpus source registry: which deterministic parser each manifest source
 * needs, and where its bytes live.
 *
 * Issue #31 spans three source families with two parse strategies — e-laws block
 * streams (statutes and regulations, {@link parseStatute}) and HTML5 prose (LTB
 * guidelines and the rent-increase page, {@link parseProse}). This table is the
 * single place that records the mapping, so the full-corpus intrinsic gate and
 * any later consumer dispatch through {@link parseSource} instead of re-deciding
 * a source's family at each call site. The `id` and `file` mirror the committed
 * corpus manifest; the registry never reads the gitignored bytes itself.
 */

import { parseProse } from './prose-parser.js'
import { parseStatute } from './rta-parser.js'
import type { ParsedDocument } from './parsed-document.js'

/** A source's parse family: an e-laws block stream, or HTML5 prose. */
export type SourceFamily = 'elaws' | 'prose'

/** One registered corpus source: its id, title, byte path, and parse family. */
export interface CorpusSource {
  /** The manifest source id (e.g. "reg-516-06"). */
  readonly id: string
  /** The document title used as the tree root label. */
  readonly title: string
  /** The byte path under corpus/raw, mirroring the manifest's `file`. */
  readonly file: string
  /** Which deterministic parser this source's family uses. */
  readonly family: SourceFamily
}

/**
 * Every manifest source and its parse family — the RTA (#8) plus the eleven from
 * issue #31. Statutes and regulations are the e-laws family; the LTB guidelines
 * and the ontario.ca rent-increase page are the prose family.
 */
export const CORPUS_SOURCES: readonly CorpusSource[] = [
  {
    id: 'rta-2006',
    title: 'Residential Tenancies Act, 2006',
    file: 'tenancy/rta-2006.html',
    family: 'elaws',
  },
  {
    id: 'reg-516-06',
    title: 'O. Reg. 516/06: General (under the Residential Tenancies Act, 2006)',
    file: 'tenancy/reg-516-06.html',
    family: 'elaws',
  },
  {
    id: 'condo-act-1998',
    title: 'Condominium Act, 1998',
    file: 'governing/condo-act-1998.html',
    family: 'elaws',
  },
  {
    id: 'reg-48-01',
    title: 'O. Reg. 48/01: General (under the Condominium Act, 1998)',
    file: 'governing/reg-48-01.html',
    family: 'elaws',
  },
  {
    id: 'ltb-guideline-01',
    title: 'Interpretation Guideline 1: Adjourning and Rescheduling Hearings',
    file: 'tenancy/ltb-guidelines/01.html',
    family: 'prose',
  },
  {
    id: 'ltb-guideline-05',
    title: 'Interpretation Guideline 5: Breach of Maintenance Obligations',
    file: 'tenancy/ltb-guidelines/05.html',
    family: 'prose',
  },
  {
    id: 'ltb-guideline-06',
    title: "Interpretation Guideline 6: Tenants' Rights",
    file: 'tenancy/ltb-guidelines/06.html',
    family: 'prose',
  },
  {
    id: 'ltb-guideline-07',
    title: 'Interpretation Guideline 7: Relief from Eviction',
    file: 'tenancy/ltb-guidelines/07.html',
    family: 'prose',
  },
  {
    id: 'ltb-guideline-11',
    title: 'Interpretation Guideline 11: Rent Arrears',
    file: 'tenancy/ltb-guidelines/11.html',
    family: 'prose',
  },
  {
    id: 'ltb-guideline-12',
    title: 'Interpretation Guideline 12: Eviction for Personal Use',
    file: 'tenancy/ltb-guidelines/12.html',
    family: 'prose',
  },
  {
    id: 'ltb-guideline-14',
    title: 'Interpretation Guideline 14: Applications for Rent Increases Above the Guideline',
    file: 'tenancy/ltb-guidelines/14.html',
    family: 'prose',
  },
  {
    id: 'rent-increase-guideline',
    title: 'Rent increase guideline (ontario.ca)',
    file: 'tenancy/rent-increase-guideline.html',
    family: 'prose',
  },
]

/** Looks up a registered source by id, or `undefined` if it is not registered. */
export function sourceById(id: string): CorpusSource | undefined {
  return CORPUS_SOURCES.find((source) => source.id === id)
}

/**
 * Parses a source's raw HTML through the deterministic parser its family needs,
 * keyed by manifest id. Throws for an unregistered id rather than guessing a
 * family, so a typo can never silently route to the wrong parser.
 */
export function parseSource(id: string, html: string): ParsedDocument {
  const source = sourceById(id)
  if (!source) throw new Error(`Cannot parse unknown source id "${id}"`)
  const input = { documentId: source.id, title: source.title, html }
  return source.family === 'elaws' ? parseStatute(input) : parseProse(input)
}
