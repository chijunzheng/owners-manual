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
})
