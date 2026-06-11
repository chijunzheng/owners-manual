import {
  documentTreeSchema,
  formatCitablePath,
  walkTree,
  type DocumentNode,
} from '@owners-manual/core'
import { describe, expect, it } from 'vitest'

import { parseStatute } from './rta-parser.js'
import { pathKey, textOf } from './parsed-document.js'

/**
 * The deterministic statute parse, exercised over a hand-built slice shaped
 * exactly like the real e-laws RTA body: a Part heading, a single-subsection
 * section, a multi-subsection section with lettered clauses, an inline first
 * subsection, a definition block, and a repealed subsection. Zero LLM
 * involvement (ADR 0004) — every assertion below is a property of the bytes.
 */
const BODY = [
  '<p class="partnum"><a name="BK0"></a>part i <br>  introduction</p>',
  '<p class="headnote">Purposes of Act</p>',
  '<p class="section"><a name="BK1"></a><strong>1 </strong>The purposes of this Act are to provide protection. 2006, c. 17, s. 1.</p>',
  '<p class="headnote">Interpretation</p>',
  '<p class="section"><a name="BK2"></a><strong>2 </strong>(1) In this Act,</p>',
  '<p class="definition">“Board” means the Landlord and Tenant Board; (“Commission”)</p>',
  '<p class="headnote">Application</p>',
  '<p class="section"><a name="BK8"></a><strong>6 </strong>(1) Paragraphs do not apply with respect to,</p>',
  '<p class="paragraph">  (a) accommodation that is subject to the Homes for Special Care Act; or</p>',
  '<p class="paragraph">  (b) accommodation that is a supported group living residence. 2006, c. 17, s. 6 (1).</p>',
  '<p class="subsection">(2) <span class="ovsmallcap">Repealed</span>: 2017, c. 13, s. 3 (2).</p>',
  '<p class="footnoteLeft"><strong>Section Amendments with date in force (d/m/y)</strong></p>',
].join('\n')

describe('parseStatute (structure)', () => {
  it('emits a tree the strict #7 schema validates', () => {
    const { tree } = parseStatute({
      documentId: 'RTA',
      title: 'Residential Tenancies Act, 2006',
      html: BODY,
    })
    expect(() => documentTreeSchema.parse(tree)).not.toThrow()
    expect(tree.kind).toBe('document')
    expect(tree.documentId).toBe('RTA')
  })

  it('nests sections under their Part', () => {
    const { tree } = parseStatute({ documentId: 'RTA', title: 'RTA', html: BODY })
    expect(tree.children).toHaveLength(1)
    const part = tree.children[0]!
    expect(part.kind).toBe('part')
    expect(part.label).toBe('I')
    expect(part.children.map((s) => `${s.kind}:${s.label}`)).toEqual([
      'section:1',
      'section:2',
      'section:6',
    ])
  })

  it('treats a section with no leading (n) as a single section node with text', () => {
    const { tree, ...parsed } = parseStatute({ documentId: 'RTA', title: 'RTA', html: BODY })
    const s1 = tree.children[0]!.children[0]!
    expect(s1.children).toHaveLength(0)
    expect(
      textOf(
        { tree, ...parsed },
        {
          documentId: 'RTA',
          segments: [
            { kind: 'part', label: 'I' },
            { kind: 'section', label: '1' },
          ],
        },
      ),
    ).toBe('The purposes of this Act are to provide protection. 2006, c. 17, s. 1.')
  })

  it('opens the inline first subsection (n) as a real subsection node', () => {
    const { tree } = parseStatute({ documentId: 'RTA', title: 'RTA', html: BODY })
    const s2 = tree.children[0]!.children[1]!
    expect(s2.label).toBe('2')
    expect(s2.children.map((c) => `${c.kind}:${c.label}`)).toEqual(['subsection:1'])
  })

  it('nests lettered clauses under their subsection', () => {
    const { tree } = parseStatute({ documentId: 'RTA', title: 'RTA', html: BODY })
    const s6 = tree.children[0]!.children[2]!
    const ss1 = s6.children.find((c) => c.label === '1')!
    expect(ss1.children.map((c) => `${c.kind}:${c.label}`)).toEqual(['clause:a', 'clause:b'])
  })

  it('keeps a repealed subsection as a node carrying its repeal text', () => {
    const parsed = parseStatute({ documentId: 'RTA', title: 'RTA', html: BODY })
    const s6 = parsed.tree.children[0]!.children[2]!
    const ss2 = s6.children.find((c) => c.label === '2')!
    expect(ss2.kind).toBe('subsection')
    expect(
      textOf(parsed, {
        documentId: 'RTA',
        segments: [
          { kind: 'part', label: 'I' },
          { kind: 'section', label: '6' },
          { kind: 'subsection', label: '2' },
        ],
      }),
    ).toMatch(/Repealed/)
  })
})

describe('parseStatute (definitions)', () => {
  // Section 2's definitions are the hardest section: each defined term is its
  // own citable unit, several carry enumerated (a)/(b) items, and one is split
  // by an interruption. v0 records each definition block as its own clause node
  // with verbatim text (never concatenated into one blob), keeping text
  // fidelity intact; the golden extraction set pins the reassembled shape.
  const DEFS = [
    '<p class="section"><a name="BK2"></a><strong>2 </strong>(1) In this Act,</p>',
    '<p class="definition">“Board” means the Landlord and Tenant Board; (“Commission”)</p>',
    '<p class="definition">“landlord” includes,</p>',
    '<p class="paragraph">  (a) the owner of a rental unit, or</p>',
    '<p class="paragraph">  (b) the heirs and assigns; (“locateur”)</p>',
  ].join('\n')

  it('records each defined term as its own clause node under the subsection', () => {
    const { tree } = parseStatute({ documentId: 'RTA', title: 'RTA', html: DEFS })
    const subsection = tree.children[0]!.children[0]!
    const defLabels = subsection.children.map((c) => `${c.kind}:${c.label}`)
    expect(defLabels).toContain('clause:Board')
    expect(defLabels).toContain('clause:landlord')
  })

  it('keeps the subsection lead text verbatim, without absorbing the definitions', () => {
    const parsed = parseStatute({ documentId: 'RTA', title: 'RTA', html: DEFS })
    const lead = textOf(parsed, {
      documentId: 'RTA',
      segments: [
        { kind: 'part', label: 'I' },
        { kind: 'section', label: '2' },
        { kind: 'subsection', label: '1' },
      ],
    })
    // Section 2 has no Part heading in this slice, so it sits directly under root.
    const leadNoPart = textOf(parsed, {
      documentId: 'RTA',
      segments: [
        { kind: 'section', label: '2' },
        { kind: 'subsection', label: '1' },
      ],
    })
    expect(lead ?? leadNoPart).toBe('In this Act,')
  })

  it('nests a definition’s enumerated (a)/(b) items under that definition', () => {
    const { tree } = parseStatute({ documentId: 'RTA', title: 'RTA', html: DEFS })
    const subsection = tree.children[0]!.children[0]!
    const landlord = subsection.children.find((c) => c.label === 'landlord')!
    expect(landlord.children.map((c) => c.label)).toEqual(['a', 'b'])
  })
})

describe('parseStatute (text sidecar)', () => {
  it('records operative text for the clause, excluding marginal notes and amendment history', () => {
    const parsed = parseStatute({ documentId: 'RTA', title: 'RTA', html: BODY })
    const clauseA = textOf(parsed, {
      documentId: 'RTA',
      segments: [
        { kind: 'part', label: 'I' },
        { kind: 'section', label: '6' },
        { kind: 'subsection', label: '1' },
        { kind: 'clause', label: 'a' },
      ],
    })
    expect(clauseA).toBe('accommodation that is subject to the Homes for Special Care Act; or')
  })

  it('does not leak headnote or footnoteLeft blocks into any node text', () => {
    const parsed = parseStatute({ documentId: 'RTA', title: 'RTA', html: BODY })
    for (const text of parsed.text.values()) {
      expect(text).not.toMatch(/Section Amendments with date in force/)
      expect(text).not.toBe('Purposes of Act')
    }
  })

  it('assigns a text entry keyed by every leaf node it parsed', () => {
    const parsed = parseStatute({ documentId: 'RTA', title: 'RTA', html: BODY })
    // Section 2's lone definition-bearing subsection is a leaf in v0 (definitions
    // are recorded as the subsection's text, not split into per-term nodes).
    const s2ss1 = textOf(parsed, {
      documentId: 'RTA',
      segments: [
        { kind: 'part', label: 'I' },
        { kind: 'section', label: '2' },
        { kind: 'subsection', label: '1' },
      ],
    })
    expect(s2ss1).toMatch(/In this Act/)
  })
})

describe('parseStatute (omitted / administrative sections)', () => {
  // e-laws marks short-title / coming-into-force / "amends other Acts" sections
  // as "Omitted" and gives them no BKn anchor and no table-of-contents entry.
  // They carry no operative text and are not citable units, so the parser does
  // not emit them — keeping the parsed section set equal to the ToC oracle.
  const WITH_OMITTED = [
    '<p class="partnum"><a name="BK0"></a>part i <br>  introduction</p>',
    '<p class="section"><a name="BK1"></a><strong>1 </strong>The purposes of this Act.</p>',
    '<p class="section"><strong>247<strong>-260</strong> </strong><span class="ovsmallcap">Omitted (amends or repeals other Acts).</span></p>',
    '<p class="section"><strong>263 </strong><span class="ovsmallcap">Omitted (enacts short title of this Act).</span></p>',
  ].join('\n')

  it('does not emit anchorless "Omitted" section blocks as section nodes', () => {
    const { tree } = parseStatute({ documentId: 'RTA', title: 'RTA', html: WITH_OMITTED })
    const sections = tree.children[0]!.children
    expect(sections.map((s) => s.label)).toEqual(['1'])
  })

  it('records no text for omitted sections', () => {
    const parsed = parseStatute({ documentId: 'RTA', title: 'RTA', html: WITH_OMITTED })
    for (const text of parsed.text.values()) {
      expect(text).not.toMatch(/Omitted/)
    }
  })
})

describe('parseStatute (citable paths)', () => {
  it('gives every node a citable path, the deepest clause included', () => {
    const { tree } = parseStatute({ documentId: 'RTA', title: 'RTA', html: BODY })
    const rendered: string[] = []
    walkTree(tree, (_node: DocumentNode, path) => rendered.push(formatCitablePath(path)))
    expect(rendered).toContain('RTA / Part I / s. 6 / (1) / (a)')
    expect(rendered).toContain('RTA / Part I / s. 1')
  })

  it('produces text keys that are exactly the citable paths of text-bearing nodes', () => {
    const parsed = parseStatute({ documentId: 'RTA', title: 'RTA', html: BODY })
    const nodePaths = new Set<string>()
    walkTree(parsed.tree, (_node, path) => nodePaths.add(pathKey(path)))
    for (const key of parsed.text.keys()) {
      expect(nodePaths.has(key)).toBe(true)
    }
  })
})
