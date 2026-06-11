import { documentTreeSchema, walkTree, type DocumentNode } from '@owners-manual/core'
import { describe, expect, it } from 'vitest'

import { parseProse } from './prose-parser.js'
import { type ParsedDocument, textOf } from './parsed-document.js'

/**
 * The Tribunals Ontario LTB interpretation guidelines and the ontario.ca
 * rent-increase page are HTML5 PROSE, not e-laws block streams: their structure
 * lives in heading levels (`<h2>`/`<h3>`/`<h4>`) with `<p>` and list-item text,
 * and they carry no table of contents and no section numbers. The deterministic
 * prose parser (ADR 0004, zero LLM) folds that heading outline into the SAME #7
 * document tree the statutes use — a top-level heading is a `section`, a nested
 * heading is a `subsection`, and each paragraph or list item is a citable
 * `clause` — so a guideline pin-cite resolves through the one cite matcher. A
 * heading node carries its own heading line as text; its label is a slug of that
 * line, so the path is human-meaningful and stable.
 *
 * This slice is shaped exactly like a real guideline (network-free): a title, a
 * preamble before any heading, `<h3>` sections, an `<h4>` nested under its
 * `<h3>`, paragraph and list-item text, and surrounding page chrome (nav,
 * footer) that the parser must excise.
 */
const PROSE = [
  '<nav>site navigation chrome</nav>',
  '<main id="main-content">',
  '<article>',
  '<h1>Interpretation Guideline 1</h1>',
  '<p>This guideline addresses rescheduling and adjourning a hearing.</p>',
  '<p>Rescheduling involves staff setting a new date.</p>',
  '<h3>General Approach of the Board</h3>',
  '<p>Parties should assume the hearing will proceed on the date stated.</p>',
  '<h3>Adjournments</h3>',
  '<p>The factors the Member may consider include:</p>',
  '<ul>',
  '  <li>the reason for the adjournment;</li>',
  '  <li>any prejudice that may result.</li>',
  '</ul>',
  '<h4>Procedural Issues</h4>',
  '<p>A request for an adjournment should be made at the beginning of the hearing.</p>',
  '</article>',
  '</main>',
  '<footer>questions or comments footer chrome</footer>',
].join('\n')

const parse = (): ParsedDocument =>
  parseProse({ documentId: 'LTB-G1', title: 'Interpretation Guideline 1', html: PROSE })

describe('parseProse over an HTML5 guideline page', () => {
  it('emits a schema-valid tree rooted at the document id', () => {
    const { tree } = parse()
    expect(() => documentTreeSchema.parse(tree)).not.toThrow()
    expect(tree.documentId).toBe('LTB-G1')
    expect(tree.kind).toBe('document')
  })

  it('makes each top-level <h3> heading a section carrying its heading text', () => {
    const parsed = parse()
    const sections = parsed.tree.children.filter(
      (n) => n.kind === 'section' && n.label !== 'preamble',
    )
    const headings = sections.map((s) =>
      textOf(parsed, { documentId: 'LTB-G1', segments: [{ kind: 'section', label: s.label }] }),
    )
    expect(headings).toEqual(['General Approach of the Board', 'Adjournments'])
  })

  it('keeps preamble paragraphs (before any heading) as their own section', () => {
    const parsed = parse()
    const preamble = parsed.tree.children.find((n) => n.label === 'preamble')!
    expect(preamble.kind).toBe('section')
    const firstClause = preamble.children[0]!
    expect(
      textOf(parsed, {
        documentId: 'LTB-G1',
        segments: [
          { kind: 'section', label: 'preamble' },
          { kind: 'clause', label: firstClause.label },
        ],
      }),
    ).toMatch(/This guideline addresses rescheduling/)
  })

  it('nests an <h4> as a subsection under the preceding <h3>, carrying its heading', () => {
    const parsed = parse()
    const adjournments = parsed.tree.children.find(
      (n) =>
        textOf(parsed, {
          documentId: 'LTB-G1',
          segments: [{ kind: 'section', label: n.label }],
        }) === 'Adjournments',
    )!
    const sub = adjournments.children.find((c) => c.kind === 'subsection')!
    expect(
      textOf(parsed, {
        documentId: 'LTB-G1',
        segments: [
          { kind: 'section', label: adjournments.label },
          { kind: 'subsection', label: sub.label },
        ],
      }),
    ).toBe('Procedural Issues')
  })

  it('records each paragraph and list item as a citable clause with verbatim text', () => {
    const parsed = parse()
    const adjournments = parsed.tree.children.find(
      (n) =>
        textOf(parsed, {
          documentId: 'LTB-G1',
          segments: [{ kind: 'section', label: n.label }],
        }) === 'Adjournments',
    )!
    const clauseTexts = adjournments.children
      .filter((c) => c.kind === 'clause')
      .map((c) =>
        textOf(parsed, {
          documentId: 'LTB-G1',
          segments: [
            { kind: 'section', label: adjournments.label },
            { kind: 'clause', label: c.label },
          ],
        }),
      )
    expect(clauseTexts).toContain('The factors the Member may consider include:')
    expect(clauseTexts).toContain('the reason for the adjournment;')
    expect(clauseTexts).toContain('any prejudice that may result.')
  })

  it('excises page chrome: no nav or footer text leaks into any node', () => {
    const parsed = parse()
    for (const text of parsed.text.values()) {
      expect(text).not.toMatch(/navigation chrome/)
      expect(text).not.toMatch(/footer chrome/)
    }
  })

  it('gives every node a citable path including the deepest clause', () => {
    const { tree } = parse()
    const paths: string[] = []
    walkTree(tree, (_n: DocumentNode, path) =>
      paths.push(path.segments.map((s) => s.kind).join('/')),
    )
    expect(paths).toContain('section/subsection/clause')
  })

  it('gives the preamble section no heading text of its own (it is a wrapper)', () => {
    const parsed = parse()
    const preamble = parsed.tree.children.find((n) => n.label === 'preamble')!
    expect(preamble.kind).toBe('section')
    expect(
      textOf(parsed, { documentId: 'LTB-G1', segments: [{ kind: 'section', label: 'preamble' }] }),
    ).toBeUndefined()
  })
})
