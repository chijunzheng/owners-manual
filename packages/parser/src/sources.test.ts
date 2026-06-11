import { describe, expect, it } from 'vitest'

import { CORPUS_SOURCES, parseSource, sourceById } from './sources.js'

/**
 * The source registry maps each manifest source to the deterministic parser its
 * family needs (e-laws block stream vs HTML5 prose). It is the single place that
 * knows "reg-516-06 is an e-laws regulation, ltb-guideline-01 is prose", so the
 * full-corpus intrinsic gate and any later consumer dispatch through one table
 * instead of re-deciding per call site.
 */
describe('CORPUS_SOURCES registry', () => {
  it('covers all 12 manifest sources (RTA plus the eleven from issue #31)', () => {
    expect(CORPUS_SOURCES).toHaveLength(12)
    const ids = CORPUS_SOURCES.map((s) => s.id)
    for (const id of [
      'rta-2006',
      'reg-516-06',
      'condo-act-1998',
      'reg-48-01',
      'ltb-guideline-01',
      'ltb-guideline-05',
      'ltb-guideline-06',
      'ltb-guideline-07',
      'ltb-guideline-11',
      'ltb-guideline-12',
      'ltb-guideline-14',
      'rent-increase-guideline',
    ]) {
      expect(ids).toContain(id)
    }
  })

  it('classifies the statutes and regulations as the e-laws family', () => {
    for (const id of ['rta-2006', 'condo-act-1998', 'reg-516-06', 'reg-48-01']) {
      expect(sourceById(id)!.family).toBe('elaws')
    }
  })

  it('classifies the LTB guidelines and rent-increase page as the prose family', () => {
    for (const id of ['ltb-guideline-01', 'ltb-guideline-14', 'rent-increase-guideline']) {
      expect(sourceById(id)!.family).toBe('prose')
    }
  })

  it('every registry file path matches the committed manifest layout', () => {
    expect(sourceById('reg-516-06')!.file).toBe('tenancy/reg-516-06.html')
    expect(sourceById('condo-act-1998')!.file).toBe('governing/condo-act-1998.html')
    expect(sourceById('ltb-guideline-07')!.file).toBe('tenancy/ltb-guidelines/07.html')
  })

  it('sourceById returns undefined for an unknown id', () => {
    expect(sourceById('does-not-exist')).toBeUndefined()
  })
})

describe('parseSource dispatch', () => {
  it('parses an e-laws source through the statute parser', () => {
    const parsed = parseSource(
      'reg-516-06',
      '<p class="section-e"><a name="BK1"></a><strong>1. </strong>A regulation section.</p>',
    )
    expect(parsed.tree.documentId).toBe('reg-516-06')
    expect(parsed.tree.children.some((n) => n.label === '1')).toBe(true)
  })

  it('parses a prose source through the prose parser', () => {
    const parsed = parseSource(
      'ltb-guideline-01',
      '<main id="main-content"><h3>A Heading</h3><p>Body.</p></main>',
    )
    expect(parsed.tree.documentId).toBe('ltb-guideline-01')
    expect(parsed.tree.children.some((n) => n.kind === 'section')).toBe(true)
  })

  it('throws for an unknown source id rather than guessing a family', () => {
    expect(() => parseSource('nope', '<p>x</p>')).toThrow(/unknown source/i)
  })
})
