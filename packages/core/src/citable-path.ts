/**
 * Citable-path addressing for the document tree.
 *
 * A pin-cite (CONTEXT.md) resolves to a specific citable unit — the smallest
 * document-tree node a citation can address. A {@link CitablePath} is the
 * machine representation of that address: a `documentId` plus an ordered list
 * of typed segments from the document root down to the cited node
 * (Part → section → subsection → clause).
 *
 * Modelling the path as structured segments (rather than a display string like
 * "RTA s. 49(1)(a)") makes the hierarchical relation a clean prefix check and
 * keeps the cross-language conformance vectors free of any parsing dialect.
 */

import { z } from 'zod'

/** The node kinds a document tree distinguishes, root-first. */
export const SEGMENT_KINDS = ['document', 'part', 'section', 'subsection', 'clause'] as const

export type SegmentKind = (typeof SEGMENT_KINDS)[number]

/** One step in a citable path: the node's kind and its label (e.g. section "49"). */
export const citablePathSegmentSchema = z
  .object({
    kind: z.enum(SEGMENT_KINDS),
    label: z.string().min(1),
  })
  .strict()

export type CitablePathSegment = z.infer<typeof citablePathSegmentSchema>

/**
 * The address of one document-tree node: which document, and the ordered
 * segments from its root to the node. An empty `segments` list addresses the
 * document root itself.
 */
export const citablePathSchema = z
  .object({
    documentId: z.string().min(1),
    segments: z.array(citablePathSegmentSchema),
  })
  .strict()

export type CitablePath = z.infer<typeof citablePathSchema>

/** Validate and normalize an untyped value into a {@link CitablePath}. */
export function parseCitablePath(value: unknown): CitablePath {
  return citablePathSchema.parse(value)
}

function segmentsEqual(a: CitablePathSegment, b: CitablePathSegment): boolean {
  return a.kind === b.kind && a.label === b.label
}

/** True when two citable paths address the same node of the same document. */
export function citablePathsEqual(a: CitablePath, b: CitablePath): boolean {
  if (a.documentId !== b.documentId) return false
  if (a.segments.length !== b.segments.length) return false
  return a.segments.every((segment, index) => segmentsEqual(segment, b.segments[index]!))
}

/**
 * True when `maybeAncestor` is a strict prefix of `maybePath` within the same
 * document — i.e. `maybeAncestor` sits strictly higher on the same line.
 * Kinds must agree segment-for-segment, so a mislabeled coordinate (a clause
 * "1" vs a subsection "1") is not treated as the same node.
 */
export function isProperAncestor(maybeAncestor: CitablePath, maybePath: CitablePath): boolean {
  if (maybeAncestor.documentId !== maybePath.documentId) return false
  if (maybeAncestor.segments.length >= maybePath.segments.length) return false
  return maybeAncestor.segments.every((segment, index) =>
    segmentsEqual(segment, maybePath.segments[index]!),
  )
}

/** True when `maybeDescendant` sits strictly lower on the same line as `maybePath`. */
export function isProperDescendant(maybeDescendant: CitablePath, maybePath: CitablePath): boolean {
  return isProperAncestor(maybePath, maybeDescendant)
}

/** Render a citable path for human review (e.g. "RTA / Part V / s. 49 / (1) / (a)"). */
export function formatCitablePath(path: CitablePath): string {
  const head = path.documentId
  const tail = path.segments.map((segment) => {
    switch (segment.kind) {
      case 'part':
        return `Part ${segment.label}`
      case 'section':
        return `s. ${segment.label}`
      case 'subsection':
      case 'clause':
        return `(${segment.label})`
      case 'document':
        return segment.label
    }
  })
  return [head, ...tail].join(' / ')
}
