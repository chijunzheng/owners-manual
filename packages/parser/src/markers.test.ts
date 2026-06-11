import { describe, expect, it } from 'vitest'

import {
  definitionTerm,
  scheduleLabel,
  splitClause,
  splitSectionNumber,
  splitSubparagraph,
  splitSubsection,
  tableTitle,
} from './markers.js'

/**
 * Coordinate-marker parsing: the small, exact rules that turn an e-laws
 * provision's leading marker ("5.1", "(2)", "(a)", "i.") into a label plus the
 * operative text after it. These are pinned directly — the parser leans on them
 * for every node coordinate, so an off-by-one in a regex would silently mis-cite.
 */
describe('splitSectionNumber', () => {
  it('splits a plain section number', () => {
    expect(splitSectionNumber('1 The purposes of this Act.')).toEqual({
      label: '1',
      rest: 'The purposes of this Act.',
    })
  })

  it('splits a sub-numbered section like 5.1 or 234.1', () => {
    expect(splitSectionNumber('5.1 text')).toMatchObject({ label: '5.1' })
    expect(splitSectionNumber('234.1 text')).toMatchObject({ label: '234.1' })
  })

  it('returns null when there is no leading number', () => {
    expect(splitSectionNumber('No number here')).toBeNull()
    expect(splitSectionNumber('')).toBeNull()
  })
})

describe('splitSubsection', () => {
  it('splits a parenthesised subsection marker', () => {
    expect(splitSubsection('(2) the body')).toEqual({ label: '2', rest: 'the body' })
  })

  it('handles a dotted subsection like (2.1)', () => {
    expect(splitSubsection('(2.1) the body')).toMatchObject({ label: '2.1' })
  })

  it('returns null without a leading (n) marker', () => {
    expect(splitSubsection('In this Act,')).toBeNull()
  })
})

describe('splitClause', () => {
  it('splits a lettered clause', () => {
    expect(splitClause('(a) the clause')).toEqual({ label: 'a', rest: 'the clause' })
  })

  it('splits a dotted lettered clause like (a.1)', () => {
    expect(splitClause('(a.1) the clause')).toMatchObject({ label: 'a.1' })
  })

  it('splits a numbered paragraph like "1."', () => {
    expect(splitClause('1. the paragraph')).toEqual({ label: '1', rest: 'the paragraph' })
  })

  it('returns null for text with no clause marker', () => {
    expect(splitClause('plain text')).toBeNull()
  })
})

describe('splitSubparagraph', () => {
  it('splits a roman sub-paragraph with a trailing period', () => {
    expect(splitSubparagraph('i. roman text')).toEqual({ label: 'i', rest: 'roman text' })
  })

  it('splits a parenthesised roman sub-paragraph', () => {
    expect(splitSubparagraph('(iv) roman text')).toMatchObject({ label: 'iv' })
  })

  it('returns null when there is no sub-paragraph marker', () => {
    expect(splitSubparagraph('plain text')).toBeNull()
  })
})

describe('definitionTerm', () => {
  it('extracts the curly-quoted defined term', () => {
    expect(definitionTerm('“Board” means the Landlord and Tenant Board;')).toBe('Board')
  })

  it('returns null for a continuation line with no leading term', () => {
    expect(definitionTerm('includes all common areas')).toBeNull()
    expect(definitionTerm('')).toBeNull()
  })
})

describe('scheduleLabel', () => {
  it('labels an unnumbered schedule as "Schedule"', () => {
    expect(scheduleLabel('Schedule Useful life of work done or thing purchased')).toBe('Schedule')
  })

  it('labels a numbered or lettered schedule with its coordinate', () => {
    expect(scheduleLabel('Schedule 1 Forms')).toBe('Schedule 1')
    expect(scheduleLabel('Schedule A Special rules')).toBe('Schedule A')
  })

  it('never mistakes a following title word for the coordinate', () => {
    // "Useful" must not be captured as the schedule number.
    expect(scheduleLabel('Schedule Useful life')).toBe('Schedule')
  })

  it('returns null for a non-schedule line', () => {
    expect(scheduleLabel('Section 5 of the Act')).toBeNull()
  })
})

describe('tableTitle', () => {
  it('labels a numbered table title', () => {
    expect(tableTitle('Table 1 Sitework')).toBe('Table 1')
    expect(tableTitle('Table 12 Roofing')).toBe('Table 12')
  })

  it('labels a bare "Table" with no number (the reg-48-01 forms table)', () => {
    expect(tableTitle('Table')).toBe('Table')
  })

  it('returns null for a heading that is not a table title', () => {
    expect(tableTitle('Tabletop discussion')).toBeNull()
    expect(tableTitle('General notes')).toBeNull()
  })
})
