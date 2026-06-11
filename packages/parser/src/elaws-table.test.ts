import { documentTreeSchema, walkTree, type DocumentNode } from '@owners-manual/core'
import { describe, expect, it } from 'vitest'

import { parseStatute } from './rta-parser.js'
import { textOf } from './parsed-document.js'

/**
 * Embedded data tables — the structure #8 explicitly deferred to #31 (e.g. O.
 * Reg. 516/06's "useful life of work" Schedule). The #7 document tree has no
 * table kind, so the deterministic parser folds a table into addressable item
 * nodes WITHOUT forking the schema: the Schedule division is a `section`, each
 * `Table N` title is a `subsection`, and every DATA ROW is a `clause` keyed by
 * its Column-1 item number, carrying the row's cells as verbatim text. Every
 * cell's text therefore lands in a citable node — so the table is covered by the
 * text-fidelity and cite round-trip asserts, not silently dropped.
 *
 * This slice mirrors the real e-laws Schedule markup (network-free, no Crown
 * text): a `schedule-e` division, a `headingx-e` table title, and a real
 * `<table>` whose cells are `table-e` paragraphs.
 */
const SCHEDULE = [
  '<p class="schedule-e"><a name="BK71"></a>Schedule <br>  Useful life of work done or thing purchased</p>',
  '<p class="headingx-e">Table 1 <br>  Sitework</p>',
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

const parse = () =>
  parseStatute({ documentId: 'REG-516-06', title: 'O. Reg. 516/06', html: SCHEDULE })

describe('parseStatute over an embedded data table (e-laws Schedule)', () => {
  it('emits a schema-valid tree even with a table in it', () => {
    const { tree } = parse()
    expect(() => documentTreeSchema.parse(tree)).not.toThrow()
  })

  it('models the Schedule division as a top-level section node', () => {
    const { tree } = parse()
    const schedule = tree.children.find((n) => n.label === 'Schedule')!
    expect(schedule.kind).toBe('section')
    expect(
      textOf(parse(), {
        documentId: 'REG-516-06',
        segments: [{ kind: 'section', label: 'Schedule' }],
      }),
    ).toMatch(/Useful life of work done or thing purchased/)
  })

  it('models each Table title as a subsection under the Schedule', () => {
    const { tree } = parse()
    const schedule = tree.children.find((n) => n.label === 'Schedule')!
    const table1 = schedule.children.find((c) => c.label === 'Table 1')!
    expect(table1.kind).toBe('subsection')
    expect(
      textOf(parse(), {
        documentId: 'REG-516-06',
        segments: [
          { kind: 'section', label: 'Schedule' },
          { kind: 'subsection', label: 'Table 1' },
        ],
      }),
    ).toMatch(/Sitework/)
  })

  it('makes every DATA ROW a citable clause keyed by its Column-1 item number', () => {
    const { tree } = parse()
    const schedule = tree.children.find((n) => n.label === 'Schedule')!
    const table1 = schedule.children.find((c) => c.label === 'Table 1')!
    // The header row is not a data item; items 1 and 2 are.
    expect(table1.children.map((r) => r.label)).toEqual(['1', '2'])
    for (const row of table1.children) expect(row.kind).toBe('clause')
  })

  it('keeps every data cell verbatim in the row node text (table is not dropped)', () => {
    const parsed = parse()
    const row1 = textOf(parsed, {
      documentId: 'REG-516-06',
      segments: [
        { kind: 'section', label: 'Schedule' },
        { kind: 'subsection', label: 'Table 1' },
        { kind: 'clause', label: '1' },
      ],
    })
    expect(row1).toContain('Concrete fences')
    expect(row1).toContain('20')
  })

  it('gives every table row a citable path', () => {
    const { tree } = parse()
    const paths: string[] = []
    walkTree(tree, (_n: DocumentNode, path) =>
      paths.push(path.segments.map((s) => `${s.kind}:${s.label}`).join('/')),
    )
    expect(paths).toContain('section:Schedule/subsection:Table 1/clause:2')
  })
})

describe('parseStatute table folding without a preceding title', () => {
  // O. Reg. 48/01's forms table opens with a bare "Table" headingx; and as a
  // safety net, a data table that arrives with NO title block at all must still
  // fold under an implicit "Table" subsection rather than being dropped, so a
  // table's rows can never silently vanish (the fidelity assert cannot catch a
  // drop, since dropped content has no node).
  const BARE = [
    '<p class="section-e"><a name="BK1"></a><strong>1. </strong>The forms.</p>',
    '<p class="headingx-e">Table</p>',
    '<table class="MsoNormalTable">',
    ' <tr><td><p class="table-e">Item</p></td><td><p class="table-e">Form</p></td></tr>',
    ' <tr><td><p class="table-e">1.</p></td><td><p class="table-e">Information Certificate</p></td></tr>',
    '</table>',
  ].join('\n')
  const NO_TITLE = [
    '<p class="section-e"><a name="BK1"></a><strong>1. </strong>The forms.</p>',
    '<table class="MsoNormalTable">',
    ' <tr><td><p class="table-e">Item</p></td><td><p class="table-e">Form</p></td></tr>',
    ' <tr><td><p class="table-e">1.</p></td><td><p class="table-e">Information Certificate</p></td></tr>',
    '</table>',
  ].join('\n')

  it('folds a bare "Table" title into a "Table" subsection with its rows', () => {
    const { tree } = parseStatute({ documentId: 'REG-48-01', title: 'O. Reg. 48/01', html: BARE })
    const section = tree.children.find((n) => n.label === '1')!
    const table = section.children.find((c) => c.label === 'Table')!
    expect(table.kind).toBe('subsection')
    expect(table.children.map((r) => r.label)).toEqual(['1'])
  })

  it('still captures a title-less data table under an implicit "Table" subsection', () => {
    const parsed = parseStatute({
      documentId: 'REG-48-01',
      title: 'O. Reg. 48/01',
      html: NO_TITLE,
    })
    const row = textOf(parsed, {
      documentId: 'REG-48-01',
      segments: [
        { kind: 'section', label: '1' },
        { kind: 'subsection', label: 'Table' },
        { kind: 'clause', label: '1' },
      ],
    })
    expect(row).toContain('Information Certificate')
  })
})
