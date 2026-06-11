import { describe, expect, it } from 'vitest'

import { checkProseCompleteness } from './intrinsic.js'
import { parseProse } from './prose-parser.js'

/**
 * The prose family (LTB guidelines, the rent-increase page) has no table of
 * contents, so the e-laws section-completeness oracle does not apply. Its
 * independent completeness oracle (ADR 0004's "every source section appears
 * exactly once" invariant, adapted) is the HEADING outline: every content
 * heading (`<h2>`–`<h6>`, excluding the level-1 page title) must become exactly
 * one heading-bearing node — a `section` or `subsection` carrying that heading
 * text — and the tree must invent no heading the source does not have. Headings
 * are re-extracted from the raw HTML by a path independent of the body fold, so
 * this compares two independently derived heading sets, exactly as the ToC
 * oracle compares two independently derived section sets.
 */
const PROSE = [
  '<main id="main-content">',
  '<h1>Interpretation Guideline 1</h1>',
  '<p>Preamble paragraph before any heading.</p>',
  '<h3>General Approach of the Board</h3>',
  '<p>Body of the first section.</p>',
  '<h3>Adjournments</h3>',
  '<p>Body of the second section.</p>',
  '<h4>Procedural Issues</h4>',
  '<p>Body of the nested subsection.</p>',
  '</main>',
].join('\n')

const parse = () =>
  parseProse({ documentId: 'LTB-G1', title: 'Interpretation Guideline 1', html: PROSE })

describe('checkProseCompleteness', () => {
  it('passes when every content heading lands in exactly one heading node', () => {
    const result = checkProseCompleteness(parse(), PROSE)
    expect(result.ok).toBe(true)
    // Three content headings: two <h3> and one <h4>; the <h1> title is excluded.
    expect(result.expected).toBe(3)
    expect(result.parsed).toBe(3)
    expect(result.missing).toEqual([])
    expect(result.unexpected).toEqual([])
    expect(result.duplicated).toEqual([])
  })

  it('names a heading the parser dropped', () => {
    const withExtra = PROSE.replace('</main>', '<h3>An Unparsed Extra Heading</h3>\n</main>')
    // The parser DOES parse it, so to simulate a drop we compare a tree built
    // from fewer headings against the richer source.
    const leaner = parseProse({
      documentId: 'LTB-G1',
      title: 'Interpretation Guideline 1',
      html: PROSE,
    })
    const result = checkProseCompleteness(leaner, withExtra)
    expect(result.ok).toBe(false)
    expect(result.missing).toContain('An Unparsed Extra Heading')
  })

  it('flags a heading node the source does not contain (invented heading)', () => {
    const richer = PROSE.replace(
      '</main>',
      '<h3>Conditions for an Adjournment</h3>\n<p>x</p>\n</main>',
    )
    const parsedRicher = parseProse({
      documentId: 'LTB-G1',
      title: 'Interpretation Guideline 1',
      html: richer,
    })
    // Grade the richer tree against the leaner source: the extra heading node is
    // unexpected relative to that source.
    const result = checkProseCompleteness(parsedRicher, PROSE)
    expect(result.ok).toBe(false)
    expect(result.unexpected).toContain('Conditions for an Adjournment')
  })

  it('ignores the preamble wrapper section (it carries no heading text)', () => {
    const result = checkProseCompleteness(parse(), PROSE)
    // The preamble holds the lead paragraph but is not itself a source heading,
    // so it must not count as an unexpected heading node.
    expect(result.unexpected).toEqual([])
  })

  it('counts heading OCCURRENCES, not distinct heading texts', () => {
    // A heading the guidelines legitimately repeat ("Adjournments" appears under
    // two sections here): the source declares it twice and the tree carries it
    // twice, so expected/parsed must be the summed occurrence totals — four
    // headings, not three distinct strings. Reporting distinct counts would leave
    // expected/parsed unchanged if a re-fetch dropped one of the repeats, hiding
    // exactly the structural drift the full-corpus pin exists to catch.
    const repeated = [
      '<main id="main-content">',
      '<h1>Interpretation Guideline 1</h1>',
      '<p>Preamble paragraph before any heading.</p>',
      '<h3>General Approach of the Board</h3>',
      '<p>Body of the first section.</p>',
      '<h3>Adjournments</h3>',
      '<p>Body of the second section.</p>',
      '<h4>Procedural Issues</h4>',
      '<p>Body of the nested subsection.</p>',
      '<h3>Adjournments</h3>',
      '<p>A second section that reuses the same heading text.</p>',
      '</main>',
    ].join('\n')
    const parsedRepeated = parseProse({
      documentId: 'LTB-G1',
      title: 'Interpretation Guideline 1',
      html: repeated,
    })
    const result = checkProseCompleteness(parsedRepeated, repeated)
    expect(result.ok).toBe(true)
    // Four heading occurrences (two "Adjournments"), three distinct texts.
    expect(result.expected).toBe(4)
    expect(result.parsed).toBe(4)
    expect(result.missing).toEqual([])
    expect(result.unexpected).toEqual([])
    expect(result.duplicated).toEqual([])
  })
})
