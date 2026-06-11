import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  checkCiteRoundTrip,
  checkProseCompleteness,
  checkSectionCompleteness,
  checkTextFidelity,
} from './intrinsic.js'
import { CORPUS_SOURCES, parseSource, type CorpusSource } from './sources.js'

/**
 * The intrinsic asserts run over EVERY parsed source in the corpus — the
 * strongest evidence that the deterministic parses (e-laws statutes and
 * regulations, and the HTML5 prose guidelines) are complete and faithful, not
 * just the RTA the #8 prior art covered.
 *
 * The source bytes are Crown / Tribunals-Ontario copyright and gitignored
 * (corpus/raw/), so they are not present in a clean CI checkout. The committed
 * golden extraction set and the fixture-based intrinsic tests are the
 * network-free per-PR gate; THIS suite is the full-document gate, which runs
 * wherever the corpus has been materialized (`pnpm corpus:fetch` on a developer
 * machine, and the scheduled/merge corpus job in CI). When a source's bytes are
 * absent the case skips with a clear reason rather than failing — the absence is
 * expected, not a regression. Set CORPUS_FULL_REQUIRED=1 to turn any skip into a
 * hard failure (the merge/nightly full-corpus job does this).
 *
 * The completeness oracle ADAPTS per family (ADR 0004): e-laws sources are
 * graded against their table of contents; prose sources, which have none, are
 * graded against their heading outline. Cite round-trip and text fidelity apply
 * everywhere. Each expected count is the value hand-verified against the pinned
 * manifest consolidation; a drift in the source bytes shows up here as a count
 * mismatch, exactly as intended.
 */

/** The expected, hand-verified shape of each source under the pinned manifest. */
interface Expectation {
  /**
   * e-laws: table-of-contents section count; prose: content-heading count. A
   * number pins the exact value (a drift then shows up here, as intended). A
   * `min` form is for the rent-increase currency micro-source, which is MEANT to
   * drift annually: its structural invariants (completeness bijection, round-trip,
   * fidelity) are pinned, but its heading count is only lower-bounded so a routine
   * annual update is not mistaken for a parser regression.
   */
  readonly completeness: number | { readonly min: number }
  /** Lower bound on text-bearing (round-tripped) nodes; guards a silent drop. */
  readonly minTextNodes: number
}

const EXPECTATIONS: Readonly<Record<string, Expectation>> = {
  'rta-2006': { completeness: 303, minTextNodes: 2000 },
  'reg-516-06': { completeness: 64, minTextNodes: 800 },
  'condo-act-1998': { completeness: 261, minTextNodes: 2000 },
  'reg-48-01': { completeness: 120, minTextNodes: 1400 },
  'ltb-guideline-01': { completeness: 14, minTextNodes: 70 },
  'ltb-guideline-05': { completeness: 26, minTextNodes: 120 },
  'ltb-guideline-06': { completeness: 23, minTextNodes: 190 },
  'ltb-guideline-07': { completeness: 13, minTextNodes: 90 },
  'ltb-guideline-11': { completeness: 25, minTextNodes: 110 },
  'ltb-guideline-12': { completeness: 25, minTextNodes: 130 },
  'ltb-guideline-14': { completeness: 45, minTextNodes: 250 },
  // Currency micro-source: bound, not pinned (it is meant to drift annually).
  'rent-increase-guideline': { completeness: { min: 8 }, minTextNodes: 40 },
}

const RAW_ROOT = join(process.cwd(), 'corpus', 'raw')
const REQUIRED = process.env.CORPUS_FULL_REQUIRED === '1'

/**
 * Sources exempt from the hard-presence requirement: the rent-increase currency
 * micro-source is fetched best-effort because it drifts annually and its bytes
 * may not checksum-match the pinned manifest on any given day. When present it is
 * still asserted in full; only its REQUIRED presence is relaxed, so a routine
 * drift cannot fail the gate as a phantom parser regression.
 */
const DRIFT_EXEMPT = new Set(['rent-increase-guideline'])

function bytesPath(source: CorpusSource): string {
  return join(RAW_ROOT, source.file)
}

if (REQUIRED) {
  const missing = CORPUS_SOURCES.filter(
    (source) => !DRIFT_EXEMPT.has(source.id) && !existsSync(bytesPath(source)),
  ).map((s) => s.id)
  if (missing.length > 0) {
    throw new Error(
      `CORPUS_FULL_REQUIRED=1 but bytes are missing for: ${missing.join(', ')} — ` +
        `run "pnpm corpus:fetch" before the full-corpus intrinsic gate.`,
    )
  }
}

describe('intrinsic asserts over the full corpus (corpus/raw present)', () => {
  for (const source of CORPUS_SOURCES) {
    const present = existsSync(bytesPath(source))
    const expectation = EXPECTATIONS[source.id]!
    const runIf = present ? describe : describe.skip

    runIf(`${source.id} (${source.family})`, () => {
      const html = present ? readFileSync(bytesPath(source), 'utf8') : ''
      const parsed = () => parseSource(source.id, html)

      it('completeness: every source division lands in the tree exactly once', () => {
        const expectCount = (actual: number): void => {
          if (typeof expectation.completeness === 'number') {
            expect(actual).toBe(expectation.completeness)
          } else {
            expect(actual).toBeGreaterThanOrEqual(expectation.completeness.min)
          }
        }
        if (source.family === 'elaws') {
          const result = checkSectionCompleteness(parsed().tree, html)
          expect(result.missing).toEqual([])
          expect(result.unexpected).toEqual([])
          expect(result.duplicated).toEqual([])
          expect(result.parsed).toBe(result.expected)
          expectCount(result.expected)
          expect(result.ok).toBe(true)
        } else {
          const result = checkProseCompleteness(parsed(), html)
          expect(result.missing).toEqual([])
          expect(result.unexpected).toEqual([])
          expect(result.duplicated).toEqual([])
          expectCount(result.expected)
          expect(result.ok).toBe(true)
        }
      })

      it('round-trips every text-bearing node: path → lookup → identical text', () => {
        const result = checkCiteRoundTrip(parsed())
        expect(result.mismatches).toEqual([])
        expect(result.checked).toBeGreaterThanOrEqual(expectation.minTextNodes)
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
})
