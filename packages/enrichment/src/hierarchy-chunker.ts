/**
 * The hierarchy chunker (#14) — the real {@link Chunker} that supersedes the
 * `citable-unit` reference stand-in on the index-time path.
 *
 * ADR 0004 / CONTEXT.md pin the chunker's correctness criterion as a LEGAL one,
 * not a semantic one: chunk boundaries MUST coincide with citable units. This
 * chunker honours that exactly — one chunk per text-bearing citable unit, in
 * document order, boundary == citable unit (a bijection enforced by tests). It
 * does NOT do similarity-based splitting or windowing; moving a boundary off a
 * citable unit would break pin-cites, so it never does.
 *
 * Where it earns its name is the chunk's embeddable TEXT, never its boundary: it
 * prepends the unit's ancestor hierarchy path ("Part II / s. 20 / (1)") to the
 * operative text. This is hierarchy-aware retrieval, not contextual enrichment:
 * a deterministic breadcrumb the parser already knows, so a bare "(1) … is void"
 * carries its section/Part context into the vector and is findable by hierarchy.
 * The operative text is included verbatim and never re-authored (ADR 0004:
 * deterministic skeleton, LLM flesh — and this is not even the LLM flesh).
 *
 * Swapping this chunker in for `citable-unit` is a pipeline-config change with a
 * content-addressed consequence: chunk ids (and therefore chunk hashes) move, so
 * chunk-level enrichment re-keys, while the tree hash and tree-level enrichment
 * keyed to it are untouched.
 */

import { formatCitablePath, walkTree, type CitablePath } from '@owners-manual/core'
import { pathKey, textOf, type ParsedDocument } from '@owners-manual/parser'

import { type Chunk, type Chunker } from './chunk.js'

/** The stable strategy id, recorded in pipeline config and the build hash. */
const HIERARCHY_CHUNKER_ID = 'hierarchy-v1'

/** The separator between the hierarchy breadcrumb and the operative text. */
const BREADCRUMB_SEPARATOR = '\n\n'

/**
 * Build the embeddable text for one citable unit: its rendered ancestor path as
 * a leading breadcrumb, then the unit's verbatim operative text. The breadcrumb
 * situates the unit so bare-coordinate text ("(1) …") is findable by hierarchy;
 * the operative text is included unchanged so the chunk still carries the
 * authoritative wording.
 */
function buildHierarchyText(path: CitablePath, operativeText: string): string {
  return `${formatCitablePath(path)}${BREADCRUMB_SEPARATOR}${operativeText}`
}

/**
 * The hierarchy chunker: one chunk per text-bearing citable unit, in document
 * order, each chunk's text situated under its ancestor hierarchy. Boundaries
 * coincide with citable units exactly.
 */
export const hierarchyChunker: Chunker = {
  id: HIERARCHY_CHUNKER_ID,
  chunk(parsed: ParsedDocument): readonly Chunk[] {
    const chunks: Chunk[] = []
    walkTree(parsed.tree, (_node, path) => {
      const operativeText = textOf(parsed, path)
      if (operativeText === undefined) return
      const key = pathKey(path)
      chunks.push({
        id: `${HIERARCHY_CHUNKER_ID}:${key}`,
        citablePathKey: key,
        text: buildHierarchyText(path, operativeText),
      })
    })
    return chunks
  },
}
