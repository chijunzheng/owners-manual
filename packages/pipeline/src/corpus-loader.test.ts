import { describe, expect, it } from 'vitest'

import { GOLDEN_V0_DOCUMENTS, loadCorpusForIngest, type HtmlReader } from './corpus-loader.js'

const LEASE_HTML = `<!doctype html><html><body>
<h1>Residential Tenancy Agreement</h1>
<h2>Pets</h2>
<p>No pets of any kind are permitted.</p>
</body></html>`

const DECLARATION_HTML = `<!doctype html><html><body>
<h1>Declaration</h1>
<h2>Article III Use and Occupation of Units</h2>
<h3>Pets</h3>
<p>Two household pets are permitted.</p>
</body></html>`

/** A reader serving the two committed fixtures; corpus statutes throw if asked. */
const fixtureReader: HtmlReader = async (relPath) => {
  if (relPath.includes('lease')) return LEASE_HTML
  if (relPath.includes('declaration')) return DECLARATION_HTML
  throw new Error(`unexpected read: ${relPath}`)
}

describe('GOLDEN_V0_DOCUMENTS', () => {
  it('is tenancy-scoped: the two statutes plus the lease and declaration fixtures', () => {
    expect(GOLDEN_V0_DOCUMENTS.map((d) => d.id).sort()).toEqual([
      'fixture-declaration',
      'fixture-lease',
      'reg-516-06',
      'rta-2006',
    ])
  })

  it('never includes the checksum-failing rent-increase-guideline source', () => {
    expect(GOLDEN_V0_DOCUMENTS.map((d) => d.id)).not.toContain('rent-increase-guideline')
  })
})

describe('loadCorpusForIngest', () => {
  it('parses each requested document into a tree + text sidecar', async () => {
    const corpus = await loadCorpusForIngest({
      documents: GOLDEN_V0_DOCUMENTS.filter((d) => d.kind === 'fixture'),
      read: fixtureReader,
    })
    expect(corpus.map((c) => c.documentId).sort()).toEqual(['fixture-declaration', 'fixture-lease'])
    const lease = corpus.find((c) => c.documentId === 'fixture-lease')
    expect(lease?.parsed.text.size).toBeGreaterThan(0)
  })

  it('routes corpus ids through parseSource and fixture ids through parseFixture', async () => {
    const corpus = await loadCorpusForIngest({
      documents: [GOLDEN_V0_DOCUMENTS.find((d) => d.id === 'fixture-lease')!],
      read: fixtureReader,
    })
    expect(corpus[0]?.parsed.tree.documentId).toBe('fixture-lease')
  })

  it('surfaces a read failure with the document id for diagnosis', async () => {
    const failing: HtmlReader = async () => {
      throw new Error('ENOENT')
    }
    await expect(
      loadCorpusForIngest({
        documents: [GOLDEN_V0_DOCUMENTS.find((d) => d.id === 'rta-2006')!],
        read: failing,
      }),
    ).rejects.toThrow(/rta-2006/)
  })
})
