/**
 * The chunker interface — the seam the hierarchy chunker (#14) satisfies — and a
 * minimal reference implementation against it.
 *
 * ADR 0004 pins the chunker's contract: chunk boundaries coincide with citable
 * units produced by deterministic tree traversal (the correctness criterion is
 * legal, not semantic). This slice does not build the real chunker; it builds
 * everything that *keys off* chunks, so all it needs is that contract as a typed
 * interface plus a reference chunker to exercise it offline.
 *
 * Chunk-level enrichment keys to the chunk hash + prompt version (ADR 0004), so
 * a {@link Chunk} carries a stable id, the citable path it covers, and its text.
 * Swapping the {@link Chunker} for #14's implementation re-derives chunk ids and
 * therefore chunk hashes, invalidating chunk-level enrichment only — the tree
 * hash, and the tree-level enrichment keyed to it, are untouched.
 */

import { createHash } from 'node:crypto'

import { walkTree } from '@owners-manual/core'
import { pathKey, textOf, type ParsedDocument } from '@owners-manual/parser'

/** One unit of chunked text: a stable id, the citable path it covers, its text. */
export interface Chunk {
  /** Stable identity of this chunk within its document; the chunk-cache key root. */
  readonly id: string
  /** The {@link pathKey} of the citable unit this chunk's boundary coincides with. */
  readonly citablePathKey: string
  /** The chunk's operative text. */
  readonly text: string
}

/**
 * The contract #14 will implement: a named, deterministic function from a parsed
 * document to an ordered list of text-bearing chunks. The `id` identifies the
 * chunking strategy and is recorded in pipeline config, so a chunker swap is a
 * config change with a content-addressed consequence.
 */
export interface Chunker {
  /** Stable identifier of this chunking strategy (e.g. "citable-unit", "hierarchy-v1"). */
  readonly id: string
  /** Deterministically derive the chunks of a parsed document, in document order. */
  chunk(parsed: ParsedDocument): readonly Chunk[]
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * The reference chunker: one chunk per text-bearing citable unit, in document
 * order, with the chunk id namespaced by the strategy id so two strategies never
 * collide on the same citable path. This is a faithful-but-minimal stand-in for
 * #14, not the hierarchy chunker.
 */
export const citableUnitChunker: Chunker = {
  id: 'citable-unit',
  chunk(parsed) {
    const chunks: Chunk[] = []
    walkTree(parsed.tree, (_node, path) => {
      const text = textOf(parsed, path)
      if (text === undefined) return
      const key = pathKey(path)
      chunks.push({ id: `${this.id}:${key}`, citablePathKey: key, text })
    })
    return chunks
  },
}

/**
 * Content-addresses a chunk by its identity, covered citable path, and text.
 * Two chunks hash equal iff all three agree; any divergence — re-worded text or
 * a shifted boundary — yields a fresh key, so only changed chunks re-enrich.
 */
export function hashChunk(chunk: Chunk): string {
  return sha256Hex(JSON.stringify([chunk.id, chunk.citablePathKey, chunk.text]))
}
