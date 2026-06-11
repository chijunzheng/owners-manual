import { describe, expect, it } from 'vitest'

import { tokenizeBlocks } from './block-tokenizer.js'

/**
 * The block tokenizer turns the e-laws HTML body into an ordered stream of
 * classified `<p class="…">` blocks — the deterministic substrate the RTA
 * parser walks. It is intentionally dumb: it classifies and slices, it does not
 * interpret structure. Each block exposes its className, its inner HTML, its
 * decoded text, and the e-laws bookmark anchor (BKn) when present.
 */
describe('tokenizeBlocks', () => {
  it('captures className, inner html, and text for a content paragraph', () => {
    const blocks = tokenizeBlocks(
      '<p class="section"><a name="BK1"></a><strong>1 </strong>The purposes of this Act.</p>',
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.className).toBe('section')
    expect(blocks[0]!.text).toBe('1 The purposes of this Act.')
    expect(blocks[0]!.anchor).toBe('BK1')
  })

  it('returns blocks in document order', () => {
    const html = [
      '<p class="partnum"><a name="BK0"></a>part i <br>  introduction</p>',
      '<p class="headnote">Purposes of Act</p>',
      '<p class="section"><a name="BK1"></a><strong>1 </strong>The purposes.</p>',
      '<p class="subsection">(2) Subsection (1) does not apply.</p>',
    ].join('\n')
    expect(tokenizeBlocks(html).map((b) => b.className)).toEqual([
      'partnum',
      'headnote',
      'section',
      'subsection',
    ])
  })

  it('leaves anchor undefined when a block has no bookmark', () => {
    const blocks = tokenizeBlocks('<p class="subsection">(2) does not apply.</p>')
    expect(blocks[0]!.anchor).toBeUndefined()
  })

  it('takes the class from a single- or double-quoted attribute', () => {
    const blocks = tokenizeBlocks("<p class='paragraph'>(a) the owner</p>")
    expect(blocks[0]!.className).toBe('paragraph')
  })

  it('ignores chrome paragraphs with no class attribute', () => {
    const blocks = tokenizeBlocks('<p>just navigation chrome</p><p class="section">real</p>')
    expect(blocks.map((b) => b.className)).toEqual(['section'])
  })

  it('preserves the raw inner html so downstream can re-inspect markup', () => {
    const blocks = tokenizeBlocks('<p class="definition">“rent” includes the <em>amount</em>;</p>')
    expect(blocks[0]!.innerHtml).toBe('“rent” includes the <em>amount</em>;')
  })

  it('handles a paragraph whose tag carries other attributes alongside class', () => {
    const blocks = tokenizeBlocks('<p style="x" class="table">Purposes of Act</p>')
    expect(blocks[0]!.className).toBe('table')
    expect(blocks[0]!.text).toBe('Purposes of Act')
  })

  it('emits a genuine data table as ONE "datatable" block, not its inner cells', () => {
    // e-laws renders a data table's cells as <p class="table-e"> paragraphs; the
    // tokenizer must surface the whole <table> as one block (so the parser can
    // fold its rows) and not also leak each cell paragraph into the stream.
    const html = [
      '<p class="section-e"><a name="BK1"></a><strong>1. </strong>The Schedule.</p>',
      '<table class="MsoNormalTable">',
      ' <tr><td><p class="table-e">1.</p></td><td><p class="table-e">Concrete fences</p></td></tr>',
      '</table>',
      '<p class="subsection-e">(2) After the table.</p>',
    ].join('\n')
    const blocks = tokenizeBlocks(html)
    expect(blocks.map((b) => b.className)).toEqual(['section-e', 'datatable', 'subsection-e'])
    // The datatable block keeps the raw table html for the row extractor.
    expect(blocks[1]!.innerHtml).toContain('<tr>')
  })

  it('does not surface the table-of-contents layout table as a datatable block', () => {
    // The ToC is its own giant <table>; it is read by the ToC oracle, not the
    // body parser. It must NOT become a datatable block, but its TOCid/table
    // cell paragraphs stay transparent in the stream so the oracle can read them
    // (the body parser ignores those classes, as it always has).
    const html = [
      '<table class="MsoNormalTable">',
      ' <tr><td><p class="TOCid-e"><a href="#BK1"><span>1.</span></a></p></td>',
      '  <td><p class="table-e">Definition</p></td></tr>',
      '</table>',
      '<p class="section-e"><strong>1. </strong>Body.</p>',
    ].join('\n')
    const classes = tokenizeBlocks(html).map((b) => b.className)
    expect(classes).not.toContain('datatable')
    expect(classes).toContain('TOCid-e')
    expect(classes).toContain('section-e')
  })
})
