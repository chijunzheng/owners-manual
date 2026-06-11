import { describe, expect, it } from 'vitest'

import { htmlFragmentToText } from './html-text.js'

/**
 * The deterministic HTML-fragment → plain-text extractor that text-fidelity and
 * cite round-trips stand on. It strips inline markup (<em>, <strong>, <a>,
 * <span>, <br>) and decodes the small fixed set of entities e-laws emits, with
 * zero DOM dependency — auditable and pure, in the spirit of the deterministic
 * ingestion track (ADR 0004).
 */
describe('htmlFragmentToText', () => {
  it('strips inline tags, keeping their text content', () => {
    expect(htmlFragmentToText('<strong>2 </strong>(1) In this Act,')).toBe('2 (1) In this Act,')
  })

  it('keeps text inside emphasis and anchor tags', () => {
    expect(
      htmlFragmentToText('means a non-profit housing co-operative under the <em>Act</em>;'),
    ).toBe('means a non-profit housing co-operative under the Act;')
    expect(htmlFragmentToText('<a href="http://x">2013, c. 3, s. 20</a>')).toBe('2013, c. 3, s. 20')
  })

  it('turns <br> into a single space', () => {
    expect(htmlFragmentToText('part i <br>  introduction')).toBe('part i introduction')
  })

  it('decodes the named entities e-laws emits', () => {
    expect(htmlFragmentToText('taxes &amp; charges')).toBe('taxes & charges')
    expect(htmlFragmentToText('a&nbsp;b')).toBe('a b')
    expect(htmlFragmentToText('&lt;tag&gt; &quot;q&quot; &#39;a&#39;')).toBe('<tag> "q" \'a\'')
  })

  it('decodes numeric entities (decimal and hex)', () => {
    expect(htmlFragmentToText('a&#160;b')).toBe('a b')
    expect(htmlFragmentToText('a&#xA0;b')).toBe('a b')
    expect(htmlFragmentToText('&#8220;Board&#8221;')).toBe('“Board”')
  })

  it('passes literal UTF-8 (curly quotes, French) through untouched', () => {
    expect(htmlFragmentToText('“Board” means the Board; (“Commission”)')).toBe(
      '“Board” means the Board; (“Commission”)',
    )
  })

  it('collapses runs of whitespace and trims, so identical text compares equal', () => {
    expect(htmlFragmentToText('  the   purposes\tof   this Act  ')).toBe('the purposes of this Act')
  })

  it('returns an empty string for markup with no text', () => {
    expect(htmlFragmentToText('<a name="BK1"></a>')).toBe('')
  })
})
