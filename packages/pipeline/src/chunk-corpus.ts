/**
 * Corpus → chunks: drives the pinned {@link Chunker} over every parsed document
 * and flattens the result into the rows the index build embeds and stores.
 *
 * This slice consumes — never duplicates — the `citableUnitChunker` reference
 * implementation from `@owners-manual/enrichment` (the seam #14's hierarchy
 * chunker replaces) and the path-keyed text sidecar from `@owners-manual/parser`
 * (the chunk-text source). A {@link CorpusChunk} carries the document id and the
 * chunker id alongside the base {@link Chunk} fields so a stored row is
 * self-describing: retrieval can tag a candidate with its document and the build
 * hash can move with the chunker.
 */

import type { Chunk, Chunker } from '@owners-manual/enrichment'
import type { ParsedDocument } from '@owners-manual/parser'

/** One parsed source paired with the id it was parsed under. */
export interface ParsedCorpusEntry {
  readonly documentId: string
  readonly parsed: ParsedDocument
}

/** A stored chunk row: the base chunk plus its document and chunker provenance. */
export interface CorpusChunk extends Chunk {
  /** The source document this chunk came from. */
  readonly documentId: string
  /** The {@link Chunker} id that produced it — recorded for the build hash. */
  readonly chunker: string
}

/**
 * Chunk every parsed document with `chunker`, in corpus order then in-document
 * order, returning the flat list of self-describing rows. Pure: no I/O, no
 * embedding — those are the index-build CLI's job.
 */
export function chunkParsedDocuments(
  corpus: readonly ParsedCorpusEntry[],
  chunker: Chunker,
): readonly CorpusChunk[] {
  return corpus.flatMap((entry) =>
    chunker.chunk(entry.parsed).map((chunk) => ({
      ...chunk,
      documentId: entry.documentId,
      chunker: chunker.id,
    })),
  )
}
