/**
 * The deterministic PROSE parser (ADR 0004, deterministic track).
 *
 * Tribunals Ontario LTB interpretation guidelines and the ontario.ca
 * rent-increase page are HTML5 prose with no table of contents and no section
 * numbers; their structure is the heading outline. This parser folds that
 * outline into the SAME typed document tree the e-laws statutes use, with zero
 * LLM involvement: the shallowest heading level becomes `section` nodes, deeper
 * headings become `subsection` nodes under the current section, and each
 * paragraph or list item becomes a citable `clause`. Heading nodes carry their
 * heading line as text and are labelled by a slug of that line, so paths are
 * stable and human-meaningful. Content that precedes the first heading is held
 * in a `preamble` section so no provision is dropped.
 *
 * Like the statute parser it assembles the tree with local mutable scaffolding
 * and emits a frozen, schema-valid {@link DocumentTree}; mutation never escapes
 * this module, and the parse is a function of the bytes alone.
 */

import {
  parseDocumentTree,
  type CitablePath,
  type DocumentNode,
  type DocumentTree,
} from '@owners-manual/core'

import { type ParsedDocument, pathKey } from './parsed-document.js'
import { tokenizeProse, type ProseBlock } from './prose-blocks.js'
import { slugify } from './slug.js'

/** Input to a prose parse: the document id, its title, and the raw HTML. */
export interface ParseProseInput {
  readonly documentId: string
  readonly title: string
  readonly html: string
}

/** A node under construction: kind/label, citable path, text, growing children. */
interface BuildNode {
  kind: 'section' | 'subsection' | 'clause'
  label: string
  path: CitablePath
  text: string
  children: BuildNode[]
}

/** The label a pre-heading wrapper section uses. */
const PREAMBLE_LABEL = 'preamble'

/**
 * The shallowest CONTENT heading level present, which anchors the section tier.
 * A level-1 heading is the page title (carried as the document title and skipped
 * as content), so the section tier is computed from level ≥ 2: an LTB guideline
 * whose content starts at `<h3>` makes `<h3>` its sections, while the
 * rent-increase page starting at `<h2>` makes `<h2>` its sections.
 */
function shallowestHeadingLevel(blocks: readonly ProseBlock[]): number {
  let shallowest = Number.POSITIVE_INFINITY
  for (const block of blocks) {
    if (block.kind === 'heading' && block.level >= 2 && block.level < shallowest) {
      shallowest = block.level
    }
  }
  return Number.isFinite(shallowest) ? shallowest : 2
}

export function parseProse(input: ParseProseInput): ParsedDocument {
  const { documentId } = input
  const blocks = tokenizeProse(input.html)
  const sectionLevel = shallowestHeadingLevel(blocks)

  const roots: BuildNode[] = []
  const pathFor = (segments: CitablePath['segments']): CitablePath => ({ documentId, segments })

  // Slug labels are disambiguated per parent so two same-titled headings under
  // one parent never collide on their citable path.
  const usedLabels = new Map<BuildNode | null, Set<string>>()
  const uniqueLabel = (parent: BuildNode | null, base: string): string => {
    const seen = usedLabels.get(parent) ?? new Set<string>()
    usedLabels.set(parent, seen)
    if (!seen.has(base)) {
      seen.add(base)
      return base
    }
    let n = 2
    while (seen.has(`${base}-${n}`)) n += 1
    const label = `${base}-${n}`
    seen.add(label)
    return label
  }

  let currentSection: BuildNode | undefined
  let currentSubsection: BuildNode | undefined

  /**
   * The section that should host content right now: the open section, or a
   * lazily-created `preamble` section when content arrives before any heading
   * (so leading paragraphs are never dropped).
   */
  const hostSection = (): BuildNode => {
    if (currentSection) return currentSection
    const label = uniqueLabel(null, PREAMBLE_LABEL)
    const preamble: BuildNode = {
      kind: 'section',
      label,
      path: pathFor([{ kind: 'section', label }]),
      text: '',
      children: [],
    }
    roots.push(preamble)
    currentSection = preamble
    return preamble
  }

  for (const block of blocks) {
    if (block.kind === 'heading') {
      // A level-1 heading is the page title (already the document title); it is
      // not a content division, so it never opens a node.
      if (block.level < 2) continue
      if (block.level <= sectionLevel) {
        const label = uniqueLabel(null, slugify(block.text))
        const section: BuildNode = {
          kind: 'section',
          label,
          path: pathFor([{ kind: 'section', label }]),
          text: block.text,
          children: [],
        }
        roots.push(section)
        currentSection = section
        currentSubsection = undefined
      } else {
        const parent = hostSection()
        const label = uniqueLabel(parent, slugify(block.text))
        const subsection: BuildNode = {
          kind: 'subsection',
          label,
          path: pathFor([...parent.path.segments, { kind: 'subsection', label }]),
          text: block.text,
          children: [],
        }
        parent.children.push(subsection)
        currentSubsection = subsection
      }
      continue
    }

    // A text block becomes a clause under the deepest open heading node.
    const host = currentSubsection ?? hostSection()
    const label = uniqueLabel(host, `p-${host.children.length + 1}`)
    const clause: BuildNode = {
      kind: 'clause',
      label,
      path: pathFor([...host.path.segments, { kind: 'clause', label }]),
      text: block.text,
      children: [],
    }
    host.children.push(clause)
  }

  const tree = freezeTree(documentId, input.title, roots)
  const text = collectText(roots)
  return { tree: parseDocumentTree(tree), text }
}

/** Recursively converts the build scaffold into the immutable tree shape. */
function freezeTree(documentId: string, title: string, roots: BuildNode[]): DocumentTree {
  const freeze = (node: BuildNode): DocumentNode => ({
    kind: node.kind,
    label: node.label,
    children: node.children.map(freeze),
  })
  return {
    kind: 'document',
    documentId,
    label: title,
    children: roots.map(freeze),
  }
}

/** Walks the build scaffold to assemble the path-keyed text sidecar. */
function collectText(roots: BuildNode[]): Map<string, string> {
  const text = new Map<string, string>()
  const recurse = (node: BuildNode): void => {
    if (node.text) text.set(pathKey(node.path), node.text)
    for (const child of node.children) recurse(child)
  }
  for (const root of roots) recurse(root)
  return text
}
