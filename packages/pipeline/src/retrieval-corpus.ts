/**
 * Retrieval-corpus fixture wiring (#14): renders the chunk rows the Python
 * harness's OFFLINE hybrid-vs-vector-only comparison runs over, for committing
 * under `evals/fixtures/retrieval/`.
 *
 * This is the chunk-text analog of the committed golden trees. It carries ONLY
 * the designed fixtures (the synthetic lease and declaration), never any
 * fetched corpus: those documents are committed and synthetic-by-construction
 * (no Crown copyright), so their chunk TEXT may be committed — exactly the line
 * golden-trees draws when it commits the addressing-only statute trees but never
 * their text. The offline comparison therefore measures the real hybrid delta
 * over real fixture text on the fixture-cite subset of golden v0; the full
 * corpus (statute cites included) is measured live against the debug endpoint,
 * where the gitignored statute text lives in Atlas.
 *
 * Rows are produced by the SAME hierarchy chunker (#14) the index build uses, so
 * the offline corpus text matches what retrieval would embed — the comparison is
 * honest about the real chunking, not a stand-in. Lives in `pipeline` (not
 * `parser`) because the hierarchy chunker is in `enrichment`, which `parser`
 * does not depend on.
 */

import { hierarchyChunker } from '@owners-manual/enrichment'
import { parseFixture } from '@owners-manual/parser'

/** One designed fixture to chunk into the retrieval-corpus fixture. */
export interface RetrievalCorpusSource {
  /** The fixture id — also the chunk rows' documentId. */
  readonly id: string
  /** Input HTML path, repo-root relative (committed fixtures only). */
  readonly inputFile: string
}

/** One committed chunk row: document id, citable path key, embeddable text. */
export interface RetrievalCorpusRow {
  readonly documentId: string
  readonly citablePathKey: string
  readonly text: string
}

/**
 * The designed fixtures whose chunk text the offline comparison searches — the
 * lease and the declaration, the two fixtures golden v0's void-clause items
 * cite. Growing the offline corpus means adding entries here and re-running the
 * generator; statute documents are deliberately absent (text uncommittable).
 */
export const RETRIEVAL_CORPUS_SOURCES: readonly RetrievalCorpusSource[] = [
  { id: 'fixture-lease', inputFile: 'corpus/fixtures/tenancy/lease.html' },
  { id: 'fixture-declaration', inputFile: 'corpus/fixtures/governing/declaration.html' },
]

/** Chunk one fixture's HTML into its retrieval-corpus rows, in document order. */
export function chunkFixtureToRows(
  source: RetrievalCorpusSource,
  html: string,
): readonly RetrievalCorpusRow[] {
  const parsed = parseFixture(source.id, html)
  return hierarchyChunker.chunk(parsed).map((chunk) => ({
    documentId: source.id,
    citablePathKey: chunk.citablePathKey,
    text: chunk.text,
  }))
}

/**
 * Render the full retrieval-corpus fixture as pretty-printed JSON (trailing
 * newline, 2-space indent — the committed-fixture diff format), given each
 * source paired with its raw HTML.
 */
export function renderRetrievalCorpus(
  sources: readonly { source: RetrievalCorpusSource; html: string }[],
): string {
  const rows = sources.flatMap(({ source, html }) => chunkFixtureToRows(source, html))
  return `${JSON.stringify(rows, null, 2)}\n`
}
