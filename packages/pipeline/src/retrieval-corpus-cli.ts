/**
 * `corpus:retrieval-fixture` entry point (#14): chunk the designed fixtures with
 * the hierarchy chunker and write the offline retrieval corpus to
 * `evals/fixtures/retrieval/fixture-chunks.json`.
 *
 * The committed JSON feeds the Python harness's offline hybrid-vs-vector
 * comparison (a reproducible CI number over real fixture text). Re-run this
 * whenever a designed fixture changes; the parser-side intrinsic gate already
 * guards the fixtures themselves. Fixtures are committed and network-free, so
 * this never reaches for gitignored bytes.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RETRIEVAL_CORPUS_SOURCES, renderRetrievalCorpus } from './retrieval-corpus.js'

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const outDir = join(repoRoot, 'evals', 'fixtures', 'retrieval')
const outFile = join(outDir, 'fixture-chunks.json')

const sources = RETRIEVAL_CORPUS_SOURCES.map((source) => ({
  source,
  html: readFileSync(join(repoRoot, source.inputFile), 'utf8'),
}))

mkdirSync(outDir, { recursive: true })
writeFileSync(outFile, renderRetrievalCorpus(sources), 'utf8')
process.stdout.write(
  `wrote evals/fixtures/retrieval/fixture-chunks.json (${sources.length} fixtures)\n`,
)
