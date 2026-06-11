/**
 * The output of the deterministic statute parse.
 *
 * Issue #7's document tree is intentionally addressing-only: a node carries its
 * kind, label, and children, and nothing else, because its two consumers —
 * retrieval and hierarchical cite grading — both need only the address
 * (CONTEXT.md: "one artifact, two consumers"). The operative legal *text* of
 * each citable unit is a separate, parallel artifact the parser also emits,
 * keyed by citable path. This keeps the `.strict()` tree schema unforked while
 * still giving the text-fidelity and cite round-trip asserts something to check
 * against — the deterministic skeleton (tree) and its recovered text live side
 * by side, never welded into one mutable node.
 */

import type { CitablePath } from '@owners-manual/core'

/**
 * A parsed source: the structural tree plus the text sidecar. `text` maps a
 * {@link pathKey}-serialized citable path to that node's operative text. Not
 * every node has text (a Part heading addresses structure, not a legal
 * provision), so the map is sparse by design.
 */
export interface ParsedDocument {
  readonly tree: import('@owners-manual/core').DocumentTree
  readonly text: ReadonlyMap<string, string>
}

/**
 * Serializes a citable path to a stable string key. The kind is part of every
 * segment so a clause "1" and a subsection "1" at the same depth never collide;
 * the `|` and `:` separators cannot appear in a kind and do not occur in e-laws
 * coordinate labels, so the encoding is unambiguous.
 */
export function pathKey(path: CitablePath): string {
  const segments = path.segments.map((segment) => `${segment.kind}:${segment.label}`)
  return [path.documentId, ...segments].join('|')
}

/** Looks up the operative text addressed by `path`, or `undefined` if none. */
export function textOf(parsed: ParsedDocument, path: CitablePath): string | undefined {
  return parsed.text.get(pathKey(path))
}
