import { describe, expect, it } from 'vitest'

import { parseStatute } from './rta-parser.js'
import { renderMarkdown } from './render-markdown.js'

/**
 * Markdown is a DERIVED render for human review, never the source of truth
 * (CONTEXT.md, "Document tree"). `renderMarkdown` walks the parsed document and
 * emits a readable outline with each node's citable coordinate and operative
 * text, so a human can eyeball a parse without trusting the renderer for
 * anything machine-checked.
 */
const BODY = [
  '<p class="partnum"><a name="BK0"></a>part i <br>  introduction</p>',
  '<p class="section"><a name="BK1"></a><strong>1 </strong>The purposes of this Act.</p>',
  '<p class="section"><a name="BK8"></a><strong>6 </strong>(1) Paragraphs do not apply to,</p>',
  '<p class="paragraph">  (a) accommodation under the Homes for Special Care Act; or</p>',
  '<p class="paragraph">  (b) a supported group living residence.</p>',
].join('\n')

const render = () =>
  renderMarkdown(
    parseStatute({ documentId: 'RTA', title: 'Residential Tenancies Act, 2006', html: BODY }),
  )

describe('renderMarkdown', () => {
  it('opens with the document title as a heading', () => {
    expect(render()).toMatch(/^# Residential Tenancies Act, 2006/)
  })

  it('renders a Part heading', () => {
    expect(render()).toMatch(/## Part I/)
  })

  it('renders sections with their number and operative text', () => {
    const md = render()
    expect(md).toContain('### s. 1')
    expect(md).toContain('The purposes of this Act.')
  })

  it('indents clauses under their subsection and shows their coordinate', () => {
    const md = render()
    expect(md).toMatch(/\(a\)\s+accommodation under the Homes for Special Care Act; or/)
    expect(md).toMatch(/\(b\)\s+a supported group living residence\./)
  })

  it('is deterministic: rendering the same parse twice is byte-identical', () => {
    expect(render()).toBe(render())
  })

  it('renders the full citable path as a comment for human cross-reference', () => {
    expect(render()).toContain('RTA / Part I / s. 6 / (1) / (a)')
  })
})
