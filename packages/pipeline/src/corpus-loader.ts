/**
 * Corpus loader: parse the golden-v0 (tenancy-only) documents into trees + text
 * sidecars the index build chunks and embeds.
 *
 * The set mirrors the golden-v0 tree sources exactly — the real RTA and Reg
 * 516/06 (statute cites) and the designed lease and declaration (void-clause
 * cites) — so retrieval can serve every required cite the dev split asks for.
 * The checksum-failing `rent-increase-guideline` source (upstream drift, known
 * issue) is absent by construction; this PR neither ingests it nor touches the
 * manifest. Parsing dispatches through the existing `parseSource` /
 * `parseFixture` registries (never re-deciding a source's family here), and the
 * file reader is injected so the unit suite parses small inline HTML offline;
 * the ingest CLI binds the reader to the gitignored `corpus/raw` bytes.
 */

import { createHash } from 'node:crypto'

import { parseFixture, parseSource, type ParsedDocument } from '@owners-manual/parser'

import { type ParsedCorpusEntry } from './chunk-corpus.js'
import { type FixtureSnapshotSource } from './run-record.js'

/** One document to ingest: its id, parse route, and repo-relative HTML path. */
export interface CorpusDocumentSource {
  readonly id: string
  /** `corpus` ids parse via `parseSource`; `fixture` ids via `parseFixture`. */
  readonly kind: 'corpus' | 'fixture'
  /** Repo-relative HTML path the injected reader resolves. */
  readonly inputFile: string
}

/**
 * The golden-v0 corpus: tenancy-only. Identical document set to
 * `GOLDEN_TREE_SOURCES` (parser) so the index serves exactly the cites the
 * golden items resolve against.
 */
export const GOLDEN_V0_DOCUMENTS: readonly CorpusDocumentSource[] = [
  { id: 'rta-2006', kind: 'corpus', inputFile: 'corpus/raw/tenancy/rta-2006.html' },
  { id: 'reg-516-06', kind: 'corpus', inputFile: 'corpus/raw/tenancy/reg-516-06.html' },
  { id: 'fixture-lease', kind: 'fixture', inputFile: 'corpus/fixtures/tenancy/lease.html' },
  {
    id: 'fixture-declaration',
    kind: 'fixture',
    inputFile: 'corpus/fixtures/governing/declaration.html',
  },
]

/** Reads one document's HTML by its repo-relative path. Injected for testing. */
export type HtmlReader = (inputFile: string) => Promise<string>

export interface LoadCorpusOptions {
  readonly documents: readonly CorpusDocumentSource[]
  readonly read: HtmlReader
}

/** Parse one document, tagging a read/parse failure with its id. */
async function loadOne(
  document: CorpusDocumentSource,
  read: HtmlReader,
): Promise<ParsedCorpusEntry> {
  let html: string
  try {
    html = await read(document.inputFile)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`failed to read ${document.id} (${document.inputFile}): ${reason}`)
  }
  const parsed: ParsedDocument =
    document.kind === 'corpus' ? parseSource(document.id, html) : parseFixture(document.id, html)
  return { documentId: document.id, parsed }
}

/** Load and parse the requested documents into parsed-corpus entries. */
export async function loadCorpusForIngest(
  options: LoadCorpusOptions,
): Promise<readonly ParsedCorpusEntry[]> {
  return Promise.all(options.documents.map((document) => loadOne(document, options.read)))
}

/**
 * Hash the committed fixture documents for the run record: the indexed corpus
 * includes fixture bytes, so the build hash must change when a fixture changes
 * (run-record.ts). Corpus sources are skipped — the manifest already pins them.
 */
export async function loadFixtureSnapshot(
  options: LoadCorpusOptions,
): Promise<readonly FixtureSnapshotSource[]> {
  const fixtures = options.documents.filter((document) => document.kind === 'fixture')
  return Promise.all(
    fixtures.map(async (document) => {
      let html: string
      try {
        html = await options.read(document.inputFile)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`failed to read ${document.id} (${document.inputFile}): ${reason}`)
      }
      return { id: document.id, sha256: createHash('sha256').update(html, 'utf8').digest('hex') }
    }),
  )
}
