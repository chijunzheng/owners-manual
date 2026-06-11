/**
 * Markdown rendering of a parsed document — a DERIVED artifact for human review,
 * never the source of truth (CONTEXT.md, "Document tree"; ADR 0004). The
 * canonical representation is the typed tree plus its text sidecar; this module
 * only flattens that pair into a readable outline so a person can sanity-check a
 * parse. Nothing machine-checked depends on the markdown, so the format is free
 * to change without touching any eval.
 *
 * The render is a pure function of the parse and therefore deterministic: the
 * same {@link ParsedDocument} always produces byte-identical markdown.
 */

import { formatCitablePath, walkTree, type CitablePath } from '@owners-manual/core'

import { type ParsedDocument, textOf } from './parsed-document.js'

/** Renders the coordinate marker shown beside a node (e.g. "Part I", "s. 6", "(a)"). */
function coordinate(path: CitablePath): string {
  const last = path.segments.at(-1)
  if (!last) return path.documentId
  switch (last.kind) {
    case 'part':
      return `Part ${last.label}`
    case 'section':
      return `s. ${last.label}`
    case 'subsection':
    case 'clause':
      return `(${last.label})`
    case 'document':
      return last.label
  }
}

/** Heading prefix per depth; clause levels are rendered as indented list items. */
function lineFor(parsed: ParsedDocument, path: CitablePath): string {
  const depth = path.segments.length
  const last = path.segments.at(-1)
  const text = textOf(parsed, path)
  const cite = formatCitablePath(path)
  const body = text ? ` ${text}` : ''

  if (!last) {
    return `# ${parsed.tree.label}`
  }
  if (last.kind === 'part') {
    return `## ${coordinate(path)}${body}`
  }
  if (last.kind === 'section') {
    return `### ${coordinate(path)}${body}  <!-- ${cite} -->`
  }
  // subsections and clauses: indented list items carrying their coordinate.
  const indent = '  '.repeat(Math.max(0, depth - 2))
  return `${indent}- ${coordinate(path)}${body}  <!-- ${cite} -->`
}

/**
 * Renders the whole parsed document to markdown: the title as an H1, Parts as
 * H2, sections as H3, and subsections/clauses as a nested list, each annotated
 * with its full citable path in a comment for cross-reference.
 */
export function renderMarkdown(parsed: ParsedDocument): string {
  const lines: string[] = []
  walkTree(parsed.tree, (_node, path) => {
    lines.push(lineFor(parsed, path))
  })
  return `${lines.join('\n')}\n`
}
