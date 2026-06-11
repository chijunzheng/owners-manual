import { describe, expect, it } from 'vitest'

import { extractContentRegion, tokenizeProse } from './prose-blocks.js'

/**
 * The prose tokenizer isolates the substantive content region of an HTML5 page,
 * drops chrome, and slices the rest into ordered heading/text blocks. On
 * ontario.ca and Tribunals-Ontario pages the substantive headings are bare
 * `<h2>`/`<h3>`; the page furniture (the in-page "On this page" table of
 * contents, the "Footnotes" trailer, the ministry footer) is the ONLY thing that
 * gives its headings a `class` attribute. So a classless heading is content and a
 * class-bearing heading is chrome — the rule that keeps the rent-increase page's
 * navigation out of the tree while leaving every LTB guideline (all bare
 * headings) intact.
 */
describe('extractContentRegion', () => {
  it('prefers the <main> region when present', () => {
    const region = extractContentRegion(
      '<nav>x</nav><main>real <p>body</p></main><footer>y</footer>',
    )
    expect(region).toContain('body')
    expect(region).not.toContain('<nav>')
  })

  it('falls back to <article>, then <body>, then the whole input', () => {
    expect(extractContentRegion('<article>a <p>b</p></article>')).toContain('b')
    expect(extractContentRegion('<body>c <p>d</p></body>')).toContain('d')
    expect(extractContentRegion('<p>e</p>')).toContain('e')
  })
})

describe('tokenizeProse', () => {
  it('emits headings (with level) and text blocks in document order', () => {
    const blocks = tokenizeProse('<main><h3>A</h3><p>one</p><h4>B</h4><p>two</p></main>')
    expect(blocks).toEqual([
      { kind: 'heading', level: 3, text: 'A' },
      { kind: 'text', level: 0, text: 'one' },
      { kind: 'heading', level: 4, text: 'B' },
      { kind: 'text', level: 0, text: 'two' },
    ])
  })

  it('treats list items as text blocks', () => {
    const blocks = tokenizeProse('<main><ul><li>first</li><li>second</li></ul></main>')
    expect(blocks.map((b) => b.text)).toEqual(['first', 'second'])
  })

  it('drops a class-bearing heading as chrome but keeps a classless heading', () => {
    const blocks = tokenizeProse(
      '<main><h2 class="small">On this page</h2><h2>Real Heading</h2><h2 class="h3">Footnotes</h2></main>',
    )
    const headings = blocks.filter((b) => b.kind === 'heading').map((b) => b.text)
    expect(headings).toEqual(['Real Heading'])
  })

  it('keeps a heading that carries only an id (still content)', () => {
    const blocks = tokenizeProse('<main><h3 id="exception">Exceptions</h3></main>')
    expect(blocks.map((b) => b.text)).toEqual(['Exceptions'])
  })

  it('strips chrome subtrees (nav, footer, script) entirely', () => {
    const blocks = tokenizeProse(
      '<main><nav><h2>Nav heading</h2></nav><p>body</p><footer><p>foot</p></footer><script>var x</script></main>',
    )
    const texts = blocks.map((b) => b.text)
    expect(texts).toContain('body')
    expect(texts).not.toContain('Nav heading')
    expect(texts).not.toContain('foot')
  })
})
