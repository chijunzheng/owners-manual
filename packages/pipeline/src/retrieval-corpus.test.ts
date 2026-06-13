import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  RETRIEVAL_CORPUS_SOURCES,
  chunkFixtureToRows,
  renderRetrievalCorpus,
  type RetrievalCorpusRow,
} from './retrieval-corpus.js'

/**
 * The retrieval-corpus fixture generator (#14): the chunk-text analog of the
 * committed golden trees, carrying ONLY the designed fixtures so no Crown text
 * is committed. The committed `evals/fixtures/retrieval/fixture-chunks.json`
 * feeds the Python harness's offline hybrid-vs-vector comparison; this pins the
 * generator that produces it and that the committed bytes are reproducible.
 */

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

function readFixture(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8')
}

describe('RETRIEVAL_CORPUS_SOURCES', () => {
  it('contains only designed fixtures (no fetched corpus / Crown text)', () => {
    for (const source of RETRIEVAL_CORPUS_SOURCES) {
      expect(source.id.startsWith('fixture-')).toBe(true)
      expect(source.inputFile.startsWith('corpus/fixtures/')).toBe(true)
    }
  })
})

describe('chunkFixtureToRows', () => {
  it('chunks a fixture into rows carrying documentId, path key, and text', () => {
    const rows = chunkFixtureToRows(
      RETRIEVAL_CORPUS_SOURCES[0]!,
      readFixture('corpus/fixtures/tenancy/lease.html'),
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.documentId).toBe('fixture-lease')
      expect(row.citablePathKey.startsWith('fixture-lease|')).toBe(true)
      expect(row.text.length).toBeGreaterThan(0)
    }
  })

  it('covers the golden-v0 void-clause cites the lease carries', () => {
    const rows = chunkFixtureToRows(
      RETRIEVAL_CORPUS_SOURCES[0]!,
      readFixture('corpus/fixtures/tenancy/lease.html'),
    )
    const keys = new Set(rows.map((r) => r.citablePathKey))
    expect(keys.has('fixture-lease|section:pets|clause:p-1')).toBe(true)
    expect(keys.has('fixture-lease|section:renewal|clause:p-1')).toBe(true)
  })
})

describe('renderRetrievalCorpus', () => {
  it('renders a JSON array with a trailing newline (committed-fixture format)', () => {
    const json = renderRetrievalCorpus([
      {
        source: RETRIEVAL_CORPUS_SOURCES[0]!,
        html: readFixture('corpus/fixtures/tenancy/lease.html'),
      },
    ])
    expect(json.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(json) as RetrievalCorpusRow[]
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0]).toHaveProperty('citablePathKey')
  })

  it('matches the committed fixture byte-for-byte (generator is reproducible)', () => {
    const committed = readFixture('evals/fixtures/retrieval/fixture-chunks.json')
    const regenerated = renderRetrievalCorpus(
      RETRIEVAL_CORPUS_SOURCES.map((source) => ({ source, html: readFixture(source.inputFile) })),
    )
    expect(regenerated).toBe(committed)
  })
})
