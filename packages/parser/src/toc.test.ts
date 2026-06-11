import { describe, expect, it } from 'vitest'

import { extractToc } from './toc.js'

/**
 * The e-laws table of contents is the independent oracle for section
 * completeness: every section it lists must appear in the parsed body exactly
 * once, and nothing else may. `extractToc` recovers that list (section numbers,
 * with their owning Part) straight from the `TOCid` / `TOCpartCenter` rows, so
 * the completeness assert compares two independently derived views of the same
 * document.
 */
const TOC_HTML = [
  '<table class="MsoNormalTable"><tbody>',
  '<tr><td colspan="3"><p class="TOCpartCenter"><span class="UnderBlue"><a href="#BK0" title="PART I"><span>PART I</span></a> <br></span>INTRODUCTION</p></td></tr>',
  '<tr><td colspan="2"><p class="TOCid"><a href="#BK1" title="Section 1."><span>1.</span></a></p></td><td><p class="table">Purposes of Act</p></td></tr>',
  '<tr><td colspan="2"><p class="TOCid"><a href="#BK2" title="Section 2."><span>2.</span></a></p></td><td><p class="table">Interpretation</p></td></tr>',
  '<tr><td colspan="2"><p class="TOCid"><a href="#BK6" title="Section 5.1"><span>5.1</span></a></p></td><td><p class="table">Other exemption from Act</p></td></tr>',
  '<tr><td colspan="3"><p class="TOCpartCenter"><span class="UnderBlue"><a href="#BK13" title="PART II"><span>PART II</span></a> <br></span>TENANCY AGREEMENTS</p></td></tr>',
  '<tr><td colspan="2"><p class="TOCid"><a href="#BK14" title="Section 10."><span>10.</span></a></p></td><td><p class="table">Selection of tenants</p></td></tr>',
  '</tbody></table>',
].join('\n')

describe('extractToc', () => {
  it('lists every section number the table of contents declares', () => {
    const toc = extractToc(TOC_HTML)
    expect(toc.sections.map((s) => s.number)).toEqual(['1', '2', '5.1', '10'])
  })

  it('records each section heading text', () => {
    const toc = extractToc(TOC_HTML)
    expect(toc.sections[0]).toMatchObject({ number: '1', heading: 'Purposes of Act' })
    expect(toc.sections[2]).toMatchObject({ number: '5.1', heading: 'Other exemption from Act' })
  })

  it('records each section bookmark anchor for cross-checking the body', () => {
    const toc = extractToc(TOC_HTML)
    expect(toc.sections[0]).toMatchObject({ number: '1', anchor: 'BK1' })
    expect(toc.sections.find((s) => s.number === '10')!.anchor).toBe('BK14')
  })

  it('attributes each section to the Part it falls under', () => {
    const toc = extractToc(TOC_HTML)
    expect(toc.sections.find((s) => s.number === '1')!.part).toBe('I')
    expect(toc.sections.find((s) => s.number === '10')!.part).toBe('II')
  })

  it('lists the Parts in document order', () => {
    const toc = extractToc(TOC_HTML)
    expect(toc.parts.map((p) => p.number)).toEqual(['I', 'II'])
    expect(toc.parts[0]).toMatchObject({ number: 'I', name: 'INTRODUCTION' })
  })

  it('preserves duplicate-free ordering even with decorative rows interleaved', () => {
    const withNoise = TOC_HTML.replace(
      '</tbody></table>',
      '<tr><td><p class="TOCheadCenter">A heading row</p></td></tr></tbody></table>',
    )
    expect(extractToc(withNoise).sections.map((s) => s.number)).toEqual(['1', '2', '5.1', '10'])
  })
})
