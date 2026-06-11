import { describe, expect, it } from 'vitest'

import * as parser from './index.js'

/**
 * The parser package's public surface: the deterministic statute parse, the
 * parsed-document artifact and its helpers, the intrinsic asserts, the markdown
 * renderer, and the golden-extraction loader. This guards against an accidental
 * export removal that would break a downstream consumer (the chunker, #14).
 */
describe('@owners-manual/parser public surface', () => {
  it('exports the statute parser and parsed-document helpers', () => {
    expect(typeof parser.parseStatute).toBe('function')
    expect(typeof parser.pathKey).toBe('function')
    expect(typeof parser.textOf).toBe('function')
  })

  it('exports the prose parser and its tokenizer/oracle (issue #31 families)', () => {
    expect(typeof parser.parseProse).toBe('function')
    expect(typeof parser.tokenizeProse).toBe('function')
    expect(typeof parser.checkProseCompleteness).toBe('function')
    expect(typeof parser.extractTableRows).toBe('function')
    expect(typeof parser.slugify).toBe('function')
  })

  it('exports the three intrinsic asserts', () => {
    expect(typeof parser.checkSectionCompleteness).toBe('function')
    expect(typeof parser.checkCiteRoundTrip).toBe('function')
    expect(typeof parser.checkTextFidelity).toBe('function')
  })

  it('exports the markdown renderer and the table-of-contents extractor', () => {
    expect(typeof parser.renderMarkdown).toBe('function')
    expect(typeof parser.extractToc).toBe('function')
  })

  it('exports the golden-extraction-set loader', () => {
    expect(typeof parser.loadGoldenExtractionSet).toBe('function')
  })

  it('round-trips a tiny parse end to end through the public API', () => {
    const parsed = parser.parseStatute({
      documentId: 'RTA',
      title: 'Residential Tenancies Act, 2006',
      html: '<p class="section"><a name="BK1"></a><strong>1 </strong>The purposes of this Act.</p>',
    })
    expect(
      parser.textOf(parsed, { documentId: 'RTA', segments: [{ kind: 'section', label: '1' }] }),
    ).toBe('The purposes of this Act.')
    expect(parser.renderMarkdown(parsed)).toMatch(/# Residential Tenancies Act, 2006/)
  })
})
