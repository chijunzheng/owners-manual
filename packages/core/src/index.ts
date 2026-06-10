/**
 * Shared core for the owners-manual TypeScript product (serving path).
 *
 * Issue #7 lands the domain foundation every later issue builds on: the typed,
 * zod-validated document tree (Part → section → subsection → clause), citable-
 * path addressing, and the hierarchical cite matcher — pinned by one cross-
 * language conformance-vector set the Python eval grader shares.
 */

export const PACKAGE_NAME = '@owners-manual/core'

/** Marks that the TypeScript workspace scaffold is wired and importable. */
export function scaffoldReady(): boolean {
  return true
}

export {
  SEGMENT_KINDS,
  type SegmentKind,
  type CitablePath,
  type CitablePathSegment,
  citablePathSchema,
  citablePathSegmentSchema,
  parseCitablePath,
  citablePathsEqual,
  isProperAncestor,
  isProperDescendant,
  formatCitablePath,
} from './citable-path.js'

export {
  type DocumentNode,
  type DocumentTree,
  documentTreeSchema,
  parseDocumentTree,
  walkTree,
  citablePathOf,
} from './document-tree.js'

export {
  CITE_VERDICTS,
  type CiteVerdict,
  type MatchCiteInput,
  matchCite,
  resolvesToNode,
  satisfiesRequirement,
} from './cite-matcher.js'

export {
  CONFORMANCE_VECTORS_PATH,
  type ConformanceCase,
  type ConformanceVectors,
  loadConformanceVectors,
} from './conformance.js'
