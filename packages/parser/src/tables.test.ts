import { describe, expect, it } from 'vitest'

import { extractTableRows, isLayoutTable } from './tables.js'

/**
 * e-laws embeds real data tables (the case #8 deferred to #31) as HTML
 * `<table>` elements whose cells are `<p class="table-e">` paragraphs — for
 * example O. Reg. 516/06's "useful life of work" Schedule, a three-column
 * (Item / Work Done / Useful life) grid. The #7 document tree has no table kind,
 * so a table is folded into addressable item nodes: each data row becomes one
 * citable unit keyed by its Column-1 item number, carrying the row's cells as
 * verbatim text. This module recovers that row grid deterministically; the
 * fold into the tree lives in the parser.
 *
 * e-laws ALSO wraps a document's table of contents in one big `<table>`; that
 * layout table is not data and must be told apart (it contains `TOCid` cells).
 */
const DATA_TABLE = [
  '<table class="MsoNormalTable">',
  ' <tr>',
  '  <td><p class="table-e">Column 1 <br>  Item</p></td>',
  '  <td><p class="table-e">Column 2 <br>  Work Done or Thing Purchased</p></td>',
  '  <td><p class="table-e">Column 3 <br>  Useful life in years</p></td>',
  ' </tr>',
  ' <tr>',
  '  <td><p class="table-e">1.</p></td>',
  '  <td><p class="table-e">Concrete fences</p></td>',
  '  <td><p class="table-e">20</p></td>',
  ' </tr>',
  ' <tr>',
  '  <td><p class="table-e">2.</p></td>',
  '  <td><p class="table-e">Steel or chain link fences</p></td>',
  '  <td><p class="table-e">15</p></td>',
  ' </tr>',
  '</table>',
].join('\n')

const TOC_TABLE = [
  '<table class="MsoNormalTable">',
  ' <tr><td colspan="2"><p class="TOCpartCenter-e"><span>PART I</span></p></td></tr>',
  ' <tr><td><p class="TOCid-e"><a href="#BK1"><span>1.</span></a></p></td>',
  '  <td><p class="table-e">Definition of care home</p></td></tr>',
  '</table>',
].join('\n')

describe('isLayoutTable', () => {
  it('flags the table-of-contents layout table (it carries TOCid cells)', () => {
    expect(isLayoutTable(TOC_TABLE)).toBe(true)
  })

  it('does not flag a genuine data table', () => {
    expect(isLayoutTable(DATA_TABLE)).toBe(false)
  })
})

describe('extractTableRows', () => {
  it('returns one row per <tr>, each a list of decoded cell texts', () => {
    const rows = extractTableRows(DATA_TABLE)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual([
      'Column 1 Item',
      'Column 2 Work Done or Thing Purchased',
      'Column 3 Useful life in years',
    ])
    expect(rows[1]).toEqual(['1.', 'Concrete fences', '20'])
    expect(rows[2]).toEqual(['2.', 'Steel or chain link fences', '15'])
  })

  it('decodes entities and collapses cell whitespace like the rest of the parser', () => {
    const rows = extractTableRows(
      '<table><tr><td><p class="table-e">a&nbsp;&amp;&nbsp;b</p></td></tr></table>',
    )
    expect(rows).toEqual([['a & b']])
  })

  it('returns no rows for a table with no <tr> (total, never throws)', () => {
    expect(extractTableRows('<table></table>')).toEqual([])
  })
})
