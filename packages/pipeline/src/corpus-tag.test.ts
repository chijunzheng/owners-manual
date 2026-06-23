import { describe, expect, it } from 'vitest'

import {
  CORPORA,
  corpusOfDocument,
  corpusOfInputFile,
  documentsForCorpora,
  type CorpusTag,
} from './corpus-tag.js'
import { GOLDEN_V0_DOCUMENTS } from './corpus-loader.js'

describe('CORPORA', () => {
  it('is the four canonical corpus tags in fixed order', () => {
    expect(CORPORA).toEqual(['tenancy', 'insurance', 'governing', 'selling'])
  })
})

describe('corpusOfInputFile', () => {
  it('reads the corpus from the first path segment', () => {
    expect(corpusOfInputFile('corpus/raw/tenancy/rta-2006.html')).toBe('tenancy')
    expect(corpusOfInputFile('corpus/fixtures/governing/declaration.html')).toBe('governing')
    expect(corpusOfInputFile('corpus/raw/insurance/master-policy.html')).toBe('insurance')
  })

  it('throws on a path whose corpus segment is not a known corpus', () => {
    expect(() => corpusOfInputFile('corpus/raw/mystery/thing.html')).toThrow(/corpus/i)
  })
})

describe('corpusOfDocument', () => {
  it('tags every golden-v0 document with its corpus', () => {
    const tagged = GOLDEN_V0_DOCUMENTS.map((d) => [d.id, corpusOfDocument(d)] as const)
    expect(tagged).toEqual([
      ['rta-2006', 'tenancy'],
      ['reg-516-06', 'tenancy'],
      ['condo-act-1998', 'governing'],
      ['fixture-lease', 'tenancy'],
      ['fixture-declaration', 'governing'],
      ['fixture-rules', 'governing'],
      ['fixture-management-policies', 'governing'],
      ['fixture-master-policy', 'insurance'],
      ['fixture-unit-policy', 'insurance'],
    ])
  })
})

describe('documentsForCorpora', () => {
  it('keeps only documents whose corpus is in the routed set, in canonical order', () => {
    const routed = documentsForCorpora(GOLDEN_V0_DOCUMENTS, ['tenancy'])
    expect(routed.map((d) => d.id)).toEqual(['rta-2006', 'reg-516-06', 'fixture-lease'])
  })

  it('routes a multi-corpus set without reordering the document list', () => {
    const corpora: readonly CorpusTag[] = ['governing', 'tenancy']
    const routed = documentsForCorpora(GOLDEN_V0_DOCUMENTS, corpora)
    // The document order is the corpus's canonical order, NOT the routing order.
    // Insurance docs (master/unit policy) are correctly excluded.
    expect(routed.map((d) => d.id)).toEqual([
      'rta-2006',
      'reg-516-06',
      'condo-act-1998',
      'fixture-lease',
      'fixture-declaration',
      'fixture-rules',
      'fixture-management-policies',
    ])
  })

  it('returns an empty list when no document matches the routed corpora', () => {
    expect(documentsForCorpora(GOLDEN_V0_DOCUMENTS, ['selling'])).toEqual([])
  })

  it('rejects an empty routed-corpora set rather than silently stuffing nothing', () => {
    expect(() => documentsForCorpora(GOLDEN_V0_DOCUMENTS, [])).toThrow(/at least one corpus/i)
  })
})
