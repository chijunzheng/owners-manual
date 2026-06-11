/**
 * The tree hash: the content-address of one parsed document, computed over its
 * structure and operative text and nothing about chunking.
 *
 * Tree-level enrichment (cross-reference graph, definitions index, amendment
 * flags) is keyed to this hash (ADR 0004), which is *why* it survives chunker
 * changes — the chunker is downstream of the tree and never feeds into this
 * digest. The hash is a SHA-256 over a canonical JSON serialization: the tree
 * walked depth-first (already order-stable) plus the text sidecar entries sorted
 * by path key so the map's insertion order can never perturb the digest.
 */

import { createHash } from 'node:crypto'

import { walkTree } from '@owners-manual/core'
import { pathKey, type ParsedDocument } from '@owners-manual/parser'

/** Lowercase hex SHA-256 of a UTF-8 string. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Serializes the structural skeleton in document order: each node contributes
 * its citable-path key (which encodes documentId + every {kind,label} segment),
 * so any structural edit — a relabel, a moved or dropped node — moves the digest.
 */
function skeletonKeys(parsed: ParsedDocument): string[] {
  const keys: string[] = []
  walkTree(parsed.tree, (_node, path) => {
    keys.push(pathKey(path))
  })
  return keys
}

/** The text sidecar as path-sorted `[key, text]` pairs, order-independent. */
function sortedText(parsed: ParsedDocument): Array<[string, string]> {
  return [...parsed.text.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * Content-addresses a parsed document by its structure and operative text.
 * Deterministic and independent of the text-map insertion order; sensitive to
 * any change in a node's address or in any provision's exact wording.
 */
export function hashTree(parsed: ParsedDocument): string {
  const canonical = JSON.stringify({
    documentId: parsed.tree.documentId,
    skeleton: skeletonKeys(parsed),
    text: sortedText(parsed),
  })
  return sha256Hex(canonical)
}
