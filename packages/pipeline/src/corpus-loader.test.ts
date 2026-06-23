import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  GOLDEN_V0_DOCUMENTS,
  corpusSourceIds,
  loadCorpusForIngest,
  loadFixtureSnapshot,
  type HtmlReader,
} from './corpus-loader.js'

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
  it('spans all five corpora: RTA, Reg 516/06, Condo Act, plus the six designed fixtures', () => {
    expect(GOLDEN_V0_DOCUMENTS.map((d) => d.id).sort()).toEqual([
      'condo-act-1998',
      'fixture-declaration',
      'fixture-lease',
      'fixture-management-policies',
      'fixture-master-policy',
      'fixture-rules',
      'fixture-unit-policy',
      'reg-516-06',
      'rta-2006',
    ])
  })

  it('never includes the checksum-failing rent-increase-guideline source', () => {
    expect(GOLDEN_V0_DOCUMENTS.map((d) => d.id)).not.toContain('rent-increase-guideline')
  })
})

describe('corpusSourceIds', () => {
  it('is the corpus-kind statute ids that pin the build — including the Condo Act', () => {
    // Ingest and serve both snapshot this set into the run record, so it must
    // include condo-act-1998: a Condo Act currency change then bumps the
    // corpusBuildHash and the ingest + serve build hashes agree (Codex PR #72).
    expect(corpusSourceIds(GOLDEN_V0_DOCUMENTS)).toEqual([
      'rta-2006',
      'reg-516-06',
      'condo-act-1998',
    ])
  })
})

describe('loadCorpusForIngest', () => {
  it('parses each requested document into a tree + text sidecar', async () => {
    const corpus = await loadCorpusForIngest({
      // The inline fixtureReader serves only the lease and declaration HTML, so
      // route just those two (the full fixture set is exercised by the live ingest).
      documents: GOLDEN_V0_DOCUMENTS.filter(
        (d) => d.id === 'fixture-lease' || d.id === 'fixture-declaration',
      ),
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

describe('loadFixtureSnapshot', () => {
  it('hashes exactly the fixture documents, skipping corpus sources', async () => {
    const snapshot = await loadFixtureSnapshot({
      // Route the two inline-HTML fixtures plus a statute: the statute is a corpus
      // source loadFixtureSnapshot must skip (the reader throws if it reads one).
      documents: GOLDEN_V0_DOCUMENTS.filter((d) =>
        ['fixture-lease', 'fixture-declaration', 'rta-2006'].includes(d.id),
      ),
      read: fixtureReader, // statutes throw if read — proves they are never read
    })
    expect(snapshot.map((s) => s.id)).toEqual(['fixture-lease', 'fixture-declaration'])
  })

  it('records the sha256 of each fixture file content', async () => {
    const snapshot = await loadFixtureSnapshot({
      documents: GOLDEN_V0_DOCUMENTS.filter((d) => d.id === 'fixture-lease'),
      read: fixtureReader,
    })
    const expected = createHash('sha256').update(LEASE_HTML, 'utf8').digest('hex')
    expect(snapshot).toEqual([{ id: 'fixture-lease', sha256: expected }])
  })

  it('surfaces a read failure with the fixture id for diagnosis', async () => {
    const failing: HtmlReader = async () => {
      throw new Error('ENOENT')
    }
    await expect(
      loadFixtureSnapshot({
        documents: GOLDEN_V0_DOCUMENTS.filter((d) => d.kind === 'fixture'),
        read: failing,
      }),
    ).rejects.toThrow(/fixture-lease/)
  })
})
