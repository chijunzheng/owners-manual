/**
 * Corpus tagging for the stuffing arms (#18). The `stuff` arm stuffs the ENTIRE
 * corpus; `stuff-oracle` stuffs only the corpus-tag-routed subset — corpus
 * selection is itself retrieval (CONTEXT.md, "Stuffing baseline"), so the oracle
 * is GIVEN which corpora are relevant and the harness measures the within-corpus
 * gap, isolating the Planner's routing lift from within-corpus retrieval.
 *
 * The corpus a document belongs to is its `inputFile`'s first path segment under
 * `corpus/raw/` or `corpus/fixtures/` — the same layout the parser registries
 * (`CORPUS_SOURCES`/`FIXTURE_SOURCES`) mirror from the committed manifest and
 * FIXTURE-DESIGN.md. Deriving it here (rather than threading a new field through
 * every source) keeps `CorpusDocumentSource` unchanged and makes a typo in a
 * corpus folder a load-time error, never a silent mis-route.
 */

import { type CorpusDocumentSource } from './corpus-loader.js'

/**
 * The four canonical corpus tags, in fixed canonical order (CONTEXT.md: "Corpus
 * names are tenancy, insurance, governing documents, selling"). The fixed order
 * is the order the `stuff` arm concatenates documents in — the order-permutation
 * probe (#18) permutes against this baseline.
 */
export const CORPORA = ['tenancy', 'insurance', 'governing', 'selling'] as const

export type CorpusTag = (typeof CORPORA)[number]

const CORPUS_SET = new Set<string>(CORPORA)

/**
 * Read the corpus tag from an `inputFile` path: the segment after `raw/` or
 * `fixtures/` (e.g. `corpus/raw/tenancy/rta-2006.html` → `tenancy`). Throws on a
 * path that names no known corpus — a mis-filed document is a build bug.
 */
export function corpusOfInputFile(inputFile: string): CorpusTag {
  const segments = inputFile.split('/')
  const anchor = segments.findIndex((s) => s === 'raw' || s === 'fixtures')
  const candidate = anchor >= 0 ? segments[anchor + 1] : undefined
  if (!candidate || !CORPUS_SET.has(candidate)) {
    throw new Error(
      `cannot determine corpus from inputFile "${inputFile}" (no known corpus segment)`,
    )
  }
  return candidate as CorpusTag
}

/** The corpus a document source belongs to (derived from its `inputFile`). */
export function corpusOfDocument(document: CorpusDocumentSource): CorpusTag {
  return corpusOfInputFile(document.inputFile)
}

/**
 * The subset of `documents` whose corpus is in `corpora`, in the documents' OWN
 * canonical order (never the routing order) — so `stuff-oracle`'s prefix order
 * is identical to `stuff`'s for the documents they share. Throws on an empty
 * routed set: stuffing nothing is a caller bug, not an empty answer.
 */
export function documentsForCorpora(
  documents: readonly CorpusDocumentSource[],
  corpora: readonly CorpusTag[],
): readonly CorpusDocumentSource[] {
  if (corpora.length === 0) {
    throw new Error('documentsForCorpora requires at least one corpus to route to')
  }
  const wanted = new Set<string>(corpora)
  return documents.filter((document) => wanted.has(corpusOfDocument(document)))
}
