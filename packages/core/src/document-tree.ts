/**
 * The typed document tree (CONTEXT.md): the canonical intermediate
 * representation of one parsed source — Part → section → subsection → clause —
 * zod-validated, with a citable path derivable for every node. Markdown is a
 * derived render for human review, never the source of truth.
 *
 * This module is deliberately small and pure: it validates trees and addresses
 * their nodes. The chunker, the critic gate, and the Python grader all build on
 * the addressing it exposes.
 */

import { z } from 'zod'

import {
  type CitablePath,
  type CitablePathSegment,
  type SegmentKind,
  SEGMENT_KINDS,
} from './citable-path.js'

// Re-exported so callers working with trees can render any derived path without
// reaching into the citable-path module directly.
export { formatCitablePath } from './citable-path.js'

/** A node of the document tree and its kind/label/children. */
export interface DocumentNode {
  kind: SegmentKind
  label: string
  /** Present on the root; the document this node belongs to. */
  documentId?: string
  children: DocumentNode[]
}

/** A whole parsed document: a tree rooted at a `document` node carrying its id. */
export interface DocumentTree extends DocumentNode {
  kind: 'document'
  documentId: string
}

const documentNodeSchema: z.ZodType<DocumentNode> = z.lazy(() =>
  z
    .object({
      kind: z.enum(SEGMENT_KINDS),
      label: z.string().min(1),
      documentId: z.string().min(1).optional(),
      children: z.array(documentNodeSchema),
    })
    .strict(),
)

/** A valid tree is rooted at a `document` node that carries a non-empty id. */
export const documentTreeSchema: z.ZodType<DocumentTree> = documentNodeSchema.superRefine(
  (node, ctx) => {
    if (node.kind !== 'document') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `document tree root must be a "document" node, got "${node.kind}"`,
      })
    }
    if (!node.documentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'document tree root must carry a non-empty documentId',
      })
    }
  },
) as z.ZodType<DocumentTree>

/** Validate and normalize an untyped value into a {@link DocumentTree}. */
export function parseDocumentTree(value: unknown): DocumentTree {
  return documentTreeSchema.parse(value)
}

/**
 * Visit every node depth-first, root included, handing each node the citable
 * path that addresses it. The root's path has an empty segment list; each
 * descendant appends its own {kind,label} segment. The root `document` segment
 * is carried by `path.documentId`, not duplicated into `segments`.
 */
export function walkTree(
  tree: DocumentTree,
  visit: (node: DocumentNode, path: CitablePath) => void,
): void {
  const recurse = (node: DocumentNode, segments: CitablePathSegment[]): void => {
    visit(node, { documentId: tree.documentId, segments })
    for (const child of node.children) {
      recurse(child, [...segments, { kind: child.kind, label: child.label }])
    }
  }
  recurse(tree, [])
}

/**
 * Resolve the citable path of `target` by identity within `tree`, or `null` if
 * `target` is not a node of the tree. Identity, not structural equality, so two
 * distinct nodes that happen to share a kind/label are never confused.
 */
export function citablePathOf(tree: DocumentTree, target: DocumentNode): CitablePath | null {
  let found: CitablePath | null = null
  const recurse = (node: DocumentNode, segments: CitablePathSegment[]): void => {
    if (found) return
    if (node === target) {
      found = { documentId: tree.documentId, segments }
      return
    }
    for (const child of node.children) {
      recurse(child, [...segments, { kind: child.kind, label: child.label }])
    }
  }
  recurse(tree, [])
  return found
}
