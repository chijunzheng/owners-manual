import { describe, expect, it } from 'vitest'

import { parseStatute } from './rta-parser.js'
import { checkCiteRoundTrip, checkSectionCompleteness, checkTextFidelity } from './intrinsic.js'

/**
 * The intrinsic ingestion asserts (ADR 0004): structure-fidelity (every source
 * section lands in the tree exactly once vs the table of contents), cite
 * round-trips (path → lookup → identical text), and a text-fidelity diff of the
 * parsed operative text against the source. Each is a pure function returning a
 * structured result, so the same checks run in CI over committed fixtures and
 * locally/nightly over the full RTA. These tests exercise them over a slice and
 * over deliberately corrupted parses so a real regression cannot pass silently.
 */
const BODY = [
  '<p class="partnum"><a name="BK0"></a>part i <br>  introduction</p>',
  '<p class="headnote">Purposes of Act</p>',
  '<p class="section"><a name="BK1"></a><strong>1 </strong>The purposes of this Act are to provide protection.</p>',
  '<p class="headnote">Interpretation</p>',
  '<p class="section"><a name="BK2"></a><strong>2 </strong>(1) In this Act,</p>',
  '<p class="definition">“Board” means the Landlord and Tenant Board;</p>',
].join('\n')

// A toy table of contents listing the two sections the body defines.
const TOC_HTML = [
  '<p class="TOCpartCenter"><span class="UnderBlue"><a href="#BK0" title="PART I"><span>PART I</span></a> <br></span>INTRODUCTION</p>',
  '<p class="TOCid"><a href="#BK1" title="Section 1."><span>1.</span></a></p><p class="table">Purposes of Act</p>',
  '<p class="TOCid"><a href="#BK2" title="Section 2."><span>2.</span></a></p><p class="table">Interpretation</p>',
].join('\n')

const parse = () => parseStatute({ documentId: 'RTA', title: 'RTA', html: BODY })

describe('checkSectionCompleteness', () => {
  it('passes when parsed sections match the table of contents one-to-one', () => {
    const result = checkSectionCompleteness(parse().tree, TOC_HTML)
    expect(result.ok).toBe(true)
    expect(result.expected).toBe(2)
    expect(result.parsed).toBe(2)
    expect(result.missing).toEqual([])
    expect(result.unexpected).toEqual([])
  })

  it('fails and names the section the parser dropped', () => {
    const tocWithThree = TOC_HTML.replace(
      '</p>',
      '</p><p class="TOCid"><a href="#BK3" title="Section 3."><span>3.</span></a></p><p class="table">Application</p>',
    )
    const result = checkSectionCompleteness(parse().tree, tocWithThree)
    expect(result.ok).toBe(false)
    expect(result.missing).toContain('3')
  })

  it('fails on a duplicated section in the tree', () => {
    const tree = parse().tree
    const part = tree.children[0]!
    const dupTree = {
      ...tree,
      children: [{ ...part, children: [...part.children, part.children[0]!] }],
    }
    const result = checkSectionCompleteness(dupTree, TOC_HTML)
    expect(result.ok).toBe(false)
    expect(result.duplicated).toContain('1')
  })
})

describe('checkCiteRoundTrip', () => {
  it('passes: every text-bearing node resolves to its own identical text', () => {
    const result = checkCiteRoundTrip(parse())
    expect(result.ok).toBe(true)
    expect(result.checked).toBeGreaterThan(0)
    expect(result.mismatches).toEqual([])
  })

  it('fails when a node text key is unreachable by walking the tree', () => {
    const parsed = parse()
    const corrupted = {
      tree: parsed.tree,
      text: new Map([...parsed.text, ['RTA|section:404', 'orphan text']]),
    }
    const result = checkCiteRoundTrip(corrupted)
    expect(result.ok).toBe(false)
    expect(result.mismatches.some((m) => m.includes('section:404'))).toBe(true)
  })
})

describe('checkTextFidelity', () => {
  it('passes when every parsed text fragment is found verbatim in the source text', () => {
    const result = checkTextFidelity(parse(), BODY)
    expect(result.ok).toBe(true)
    expect(result.coverageRatio).toBeGreaterThan(0.99)
  })

  it('fails when a parsed node carries text absent from the source', () => {
    const parsed = parse()
    const tampered = {
      tree: parsed.tree,
      text: new Map([
        ...parsed.text,
        ['RTA|part:I|section:1', 'fabricated provision not in source'],
      ]),
    }
    const result = checkTextFidelity(tampered, BODY)
    expect(result.ok).toBe(false)
    expect(result.unfaithful.length).toBeGreaterThan(0)
  })
})
