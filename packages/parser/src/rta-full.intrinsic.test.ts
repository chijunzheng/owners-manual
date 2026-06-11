import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { checkCiteRoundTrip, checkSectionCompleteness, checkTextFidelity } from './intrinsic.js'
import { parseStatute } from './rta-parser.js'

/**
 * The intrinsic asserts run over the FULL Residential Tenancies Act — the
 * strongest evidence that the deterministic parse is complete and faithful.
 *
 * The RTA bytes are Crown copyright and gitignored (corpus/raw/), so they are
 * not present in a clean CI checkout. The committed golden extraction set and
 * the fixture-based intrinsic tests are the network-free CI gate; THIS suite is
 * the full-document gate, which runs wherever the corpus has been materialized
 * (`pnpm corpus:fetch` on a developer machine, and the scheduled corpus job in
 * CI). When the bytes are absent it skips with a clear reason rather than
 * failing — the absence is expected, not a regression. Set RTA_FULL_REQUIRED=1
 * to turn the skip into a hard failure (the nightly/full-corpus job does this).
 */
const RTA_PATH = join(process.cwd(), 'corpus', 'raw', 'tenancy', 'rta-2006.html')
const RTA_PRESENT = existsSync(RTA_PATH)
const REQUIRED = process.env.RTA_FULL_REQUIRED === '1'

if (REQUIRED && !RTA_PRESENT) {
  throw new Error(
    `RTA_FULL_REQUIRED=1 but ${RTA_PATH} is missing — run "pnpm corpus:fetch" before the full-corpus intrinsic gate.`,
  )
}

const describeFull = RTA_PRESENT ? describe : describe.skip

describeFull('intrinsic asserts over the full RTA (corpus/raw present)', () => {
  const html = RTA_PRESENT ? readFileSync(RTA_PATH, 'utf8') : ''
  const parsed = () =>
    parseStatute({ documentId: 'RTA', title: 'Residential Tenancies Act, 2006', html })

  it('parses every table-of-contents section exactly once, inventing none', () => {
    const result = checkSectionCompleteness(parsed().tree, html)
    expect(result.missing).toEqual([])
    expect(result.unexpected).toEqual([])
    expect(result.duplicated).toEqual([])
    expect(result.parsed).toBe(result.expected)
    // The RTA's table of contents lists 303 substantive sections.
    expect(result.expected).toBe(303)
    expect(result.ok).toBe(true)
  })

  it('round-trips every text-bearing node: path → lookup → identical text', () => {
    const result = checkCiteRoundTrip(parsed())
    expect(result.mismatches).toEqual([])
    expect(result.checked).toBeGreaterThan(2000)
    expect(result.ok).toBe(true)
  })

  it('recovers every provision verbatim from the source (text fidelity)', () => {
    const result = checkTextFidelity(parsed(), html)
    expect(result.unfaithful).toEqual([])
    expect(result.coverageRatio).toBe(1)
    expect(result.ok).toBe(true)
  })
})
