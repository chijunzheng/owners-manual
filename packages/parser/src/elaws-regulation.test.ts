import { documentTreeSchema, walkTree, type DocumentNode } from '@owners-manual/core'
import { describe, expect, it } from 'vitest'

import { parseStatute } from './rta-parser.js'
import { textOf } from './parsed-document.js'
import { extractToc } from './toc.js'

/**
 * e-laws renders bilingual REGULATIONS with the same structural vocabulary as
 * unilingual statutes, but every content class carries an English-variant `-e`
 * suffix (`section-e`, `subsection-e`, `clause-e`, `partnum-e`, `TOCid-e`, …)
 * and section numbers print with a trailing period (`1.`) where statutes print
 * none (`1`). The deterministic parser (ADR 0004) must fold the regulation
 * stream into the SAME document tree as a statute — same kinds, same citable
 * paths — with zero LLM involvement, so O. Reg. 516/06 and O. Reg. 48/01 join
 * the corpus on the existing #8 track rather than a forked one.
 *
 * This slice is hand-built in the regulation dialect (network-free, no Crown
 * text) and shaped exactly like the real e-laws regulation body: a `-e` Part,
 * a `-e` section opening an inline subsection, lettered `-e` clauses, a numbered
 * `-e` paragraph, and a `-e` definition block with enumerated items.
 */
const REG_BODY = [
  '<p class="partnum-e"><a name="BK0"></a>PART I <br>  INTERPRETATION AND EXEMPTIONS</p>',
  '<p class="headnote-e">Definition of “care home”</p>',
  '<p class="section-e">  <a name="BK1"></a><strong>1. </strong>(1) One or more rental units that form part of a residential complex are care homes.  O. Reg. 516/06, s. 1 (1).</p>',
  '<p class="subsection-e">  (2) Subsection (1) applies even if a third party rents the rental unit from the landlord.  O. Reg. 516/06, s. 1 (2).</p>',
  '<p class="headnote-e">Prescribed programs</p>',
  '<p class="section-e">  <a name="BK5"></a><strong>5. </strong>The following are prescribed as programs for the purpose of the Act,</p>',
  '<p class="paragraph-e">  1.  A program established under an Act.</p>',
  '<p class="clause-e">  (a)  a rental unit described in section 7 of the Act;</p>',
  '<p class="headnote-e">Interpretation</p>',
  '<p class="section-e">  <a name="BK8"></a><strong>8. </strong>(1) In this Part,</p>',
  '<p class="definition-e">“incurred” means, in relation to a capital expenditure,</p>',
  '<p class="defclause-e">  (a)  the cost has been paid in full, or</p>',
  '<p class="firstdef-e">“work” means maintenance, repairs or capital improvements.  O. Reg. 516/06, s. 8 (1).</p>',
].join('\n')

const parse = () =>
  parseStatute({ documentId: 'REG-516-06', title: 'O. Reg. 516/06', html: REG_BODY })

describe('parseStatute over e-laws regulations (-e dialect)', () => {
  it('emits a schema-valid tree from the -e variant classes', () => {
    const { tree } = parse()
    expect(() => documentTreeSchema.parse(tree)).not.toThrow()
    expect(tree.documentId).toBe('REG-516-06')
  })

  it('nests -e sections under their -e Part, tolerating the trailing-period number', () => {
    const { tree } = parse()
    expect(tree.children).toHaveLength(1)
    const part = tree.children[0]!
    expect(part.kind).toBe('part')
    expect(part.label).toBe('I')
    expect(part.children.map((s) => `${s.kind}:${s.label}`)).toEqual([
      'section:1',
      'section:5',
      'section:8',
    ])
  })

  it('opens an inline first subsection of a -e section as a real subsection node', () => {
    const { tree } = parse()
    const s1 = tree.children[0]!.children[0]!
    expect(s1.children.map((c) => `${c.kind}:${c.label}`)).toEqual(['subsection:1', 'subsection:2'])
  })

  it('nests a -e clause and a -e numbered paragraph under their section', () => {
    const { tree } = parse()
    const s5 = tree.children[0]!.children.find((s) => s.label === '5')!
    const labels = s5.children.map((c) => `${c.kind}:${c.label}`)
    expect(labels).toContain('clause:1')
    expect(labels).toContain('clause:a')
  })

  it('records each -e definition term as its own clause node with enumerated items', () => {
    const { tree } = parse()
    const s8 = tree.children[0]!.children.find((s) => s.label === '8')!
    const ss1 = s8.children.find((c) => c.label === '1')!
    const incurred = ss1.children.find((c) => c.label === 'incurred')!
    expect(incurred.kind).toBe('clause')
    expect(incurred.children.map((c) => c.label)).toEqual(['a'])
    expect(ss1.children.map((c) => c.label)).toContain('work')
  })

  it('keeps -e operative text verbatim and citable', () => {
    const parsed = parse()
    const text = textOf(parsed, {
      documentId: 'REG-516-06',
      segments: [
        { kind: 'part', label: 'I' },
        { kind: 'section', label: '8' },
        { kind: 'subsection', label: '1' },
        { kind: 'clause', label: 'work' },
      ],
    })
    expect(text).toMatch(/^“work” means maintenance/)
  })

  it('gives every node a citable path including the deepest -e clause', () => {
    const { tree } = parse()
    const rendered: string[] = []
    walkTree(tree, (_n: DocumentNode, path) =>
      rendered.push(path.segments.map((s) => `${s.kind}:${s.label}`).join('/')),
    )
    expect(rendered).toContain('part:I/section:5/clause:a')
  })
})

describe('extractToc over an e-laws regulation table of contents (-e dialect)', () => {
  const TOC = [
    '<p class="TOCpartCenter-e"><span class="UnderBlue"><a href="#BK0" title="PART I"><span>PART I</span></a> <br>   </span>INTERPRETATION AND EXEMPTIONS</p>',
    '<p class="TOCid-e"><a href="#BK1" title="Section 1."><span>1.</span></a></p>',
    '<p class="table-e">Definition of “care home”</p>',
    '<p class="TOCid-e"><a href="#BK5" title="Section 5."><span>5.</span></a></p>',
    '<p class="table-e">Prescribed programs</p>',
  ].join('\n')

  it('recovers Parts and sections from the -e ToC classes', () => {
    const toc = extractToc(TOC)
    expect(toc.parts.map((p) => p.number)).toEqual(['I'])
    expect(toc.sections.map((s) => s.number)).toEqual(['1', '5'])
    expect(toc.sections[0]!.part).toBe('I')
  })
})
