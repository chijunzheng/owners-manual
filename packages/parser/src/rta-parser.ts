/**
 * The deterministic statute parser (ADR 0004, deterministic track).
 *
 * Folds the e-laws block stream into the typed document tree — Part → section →
 * subsection → clause — with zero LLM involvement: every node and every
 * coordinate is a function of the source bytes alone, so the parse is
 * reproducible and content-addressable. Alongside the structural tree it emits
 * the text sidecar (see {@link ParsedDocument}): the operative text of each
 * citable unit, keyed by citable path, which the text-fidelity and cite
 * round-trip asserts check. Marginal notes (`headnote`) and amendment history
 * (`footnoteLeft`) are layout/metadata, not operative provisions, so they are
 * not recorded as node text.
 *
 * The builder uses local mutable scaffolding to assemble the tree in one pass,
 * then emits a frozen, schema-valid {@link DocumentTree}; mutation never escapes
 * this module.
 */

import {
  parseDocumentTree,
  type CitablePath,
  type DocumentNode,
  type DocumentTree,
} from '@owners-manual/core'

import { DATATABLE_CLASS, tokenizeBlocks } from './block-tokenizer.js'
import { normalizeElawsClass } from './elaws-class.js'
import {
  definitionTerm,
  scheduleLabel,
  scheduleRest,
  splitClause,
  splitSectionNumber,
  splitSubparagraph,
  splitSubsection,
  tableTitle,
  tableTitleRest,
} from './markers.js'
import { extractTableRows } from './tables.js'
// htmlFragmentToText is applied inside the tokenizer; the parser works on the
// already-decoded `block.text`.
import { type ParsedDocument, pathKey } from './parsed-document.js'

/** Input to a statute parse: the document id, its title, and the raw HTML. */
export interface ParseStatuteInput {
  readonly documentId: string
  readonly title: string
  readonly html: string
}

/** A node under construction: kind/label, its citable path, and growing children. */
interface BuildNode {
  kind: 'part' | 'section' | 'subsection' | 'clause'
  label: string
  path: CitablePath
  text: string
  children: BuildNode[]
}

// Class names below are the NORMALIZED (suffix-stripped) e-laws vocabulary; the
// loop runs `normalizeElawsClass` first so the statute (`paragraph`) and
// regulation (`paragraph-e`) dialects hit the same set.
//
/**
 * Content block classes that carry clause-level provisions. The two e-laws
 * dialects map classes to roles differently: a statute prints BOTH a lettered
 * `(a)` clause and a numbered `1.` paragraph as `class="paragraph"`, while a
 * regulation prints the lettered clause as `class="clause"` and the numbered
 * paragraph as `class="paragraph"`. Both spellings are clause-level here, and
 * the marker split (lettered vs numbered) recovers the label either way. The
 * `def*` variants are a definition's own enumerated items (e.g. `(a)` under
 * `“incurred” means,`); they route through the clause handler so the active
 * definition adopts them.
 */
const CLAUSE_CLASSES = new Set([
  'paragraph',
  'clause',
  'Yparagraph',
  'Yclause',
  'defparagraph',
  'defclause',
  'defsubclause',
])
/** Content block classes that carry sub-paragraph provisions (nested clauses). */
const SUBPARA_CLASSES = new Set([
  'subpara',
  'subclause',
  'subsubpara',
  'subsubclause',
  'subsubsubpara',
  'Ysubpara',
])
/** Subsection-level block classes (the "not yet in force" Y-variant included). */
const SUBSECTION_CLASSES = new Set(['subsection', 'Ysubsection'])
/** Definition lines: each becomes its own citable clause node under the subsection. */
const DEFINITION_CLASSES = new Set(['definition', 'firstdef', 'Sdefinition'])

interface Cursor {
  part?: BuildNode
  section?: BuildNode
  subsection?: BuildNode
  clause?: BuildNode
  /** The active definition node, so its enumerated (a)/(b) items nest under it. */
  definition?: BuildNode
  /** Count of definitions seen in the current subsection, for fallback labels. */
  definitionIndex: number
  /** The active table subsection (a `headingx` title), so its rows nest under it. */
  table?: BuildNode
  /** Count of unlabelled table rows in the active table, for fallback item keys. */
  tableRowIndex: number
}

/** "part i" / "PART V.1" → "I" / "V.1" (upper-cased roman/coordinate). */
function partNumberFromText(text: string): string | undefined {
  const match = /^part\s+([ivxlcdm]+(?:\.\d+)?)\b/i.exec(text.trim())
  return match ? match[1]!.toUpperCase() : undefined
}

export function parseStatute(input: ParseStatuteInput): ParsedDocument {
  const { documentId } = input
  const childOfRoot: BuildNode[] = []
  const cursor: Cursor = { definitionIndex: 0, tableRowIndex: 0 }

  const pathFor = (segments: CitablePath['segments']): CitablePath => ({ documentId, segments })

  /** Clears the definition and table context whenever a new section opens. */
  const resetDefinitions = (): void => {
    cursor.definition = undefined
    cursor.definitionIndex = 0
    cursor.table = undefined
    cursor.tableRowIndex = 0
  }

  /** "1." / "1" / "i." → "1" / "i" — the leading item coordinate of a row. */
  const rowItemLabel = (cell: string | undefined): string | null => {
    const match = /^([0-9]+(?:\.\d+)*|[ivxlcdm]+)\.?$/i.exec((cell ?? '').trim())
    return match ? match[1]! : null
  }

  /**
   * Ensures there is a table subsection to fold rows into. Normally a `headingx`
   * title has already opened one; a data table that arrives without a preceding
   * title (none occur in the current corpus, but the guard keeps a future one
   * from being silently dropped) gets an implicit "Table" subsection under the
   * current section. Returns undefined only when there is no section to host it.
   */
  const ensureTableHost = (): BuildNode | undefined => {
    if (cursor.table) return cursor.table
    if (!cursor.section) return undefined
    const label = 'Table'
    const host: BuildNode = {
      kind: 'subsection',
      label,
      path: pathFor([...cursor.section.path.segments, { kind: 'subsection', label }]),
      text: '',
      children: [],
    }
    cursor.section.children.push(host)
    cursor.subsection = host
    cursor.table = host
    cursor.tableRowIndex = 0
    return host
  }

  /**
   * Folds a data table's rows into citable clause nodes under the active table
   * subsection (a `headingx` title, or an implicit one from
   * {@link ensureTableHost}). The first row is the column header; its cell texts
   * attach to the subsection so they stay verbatim for the fidelity assert. Each
   * later row is one item, keyed by its Column-1 coordinate (or a positional
   * `row-N` fallback when the first cell is not a coordinate), with the whole
   * row's cells joined as its text.
   */
  const foldTable = (tableHtml: string): void => {
    const host = ensureTableHost()
    if (!host) return
    const rows = extractTableRows(tableHtml).filter((cells) =>
      cells.some((cell) => cell.length > 0),
    )
    if (rows.length === 0) return
    const [header, ...dataRows] = rows
    // Cells are joined with a single space so the row text is the same contiguous
    // string the source yields once its cell tags are stripped and whitespace is
    // collapsed — keeping every table cell a verbatim slice under the fidelity
    // assert (the e-laws cells sit adjacent in document order, no separator).
    const headerText = (header ?? []).filter((cell) => cell.length > 0).join(' ')
    host.text = host.text ? `${host.text} ${headerText}` : headerText
    for (const cells of dataRows) {
      cursor.tableRowIndex += 1
      const label = rowItemLabel(cells[0]) ?? `row-${cursor.tableRowIndex}`
      const rowText = cells.filter((cell) => cell.length > 0).join(' ')
      const row: BuildNode = {
        kind: 'clause',
        label,
        path: pathFor([...host.path.segments, { kind: 'clause', label }]),
        text: rowText,
        children: [],
      }
      host.children.push(row)
    }
  }

  for (const block of tokenizeBlocks(input.html)) {
    // Collapse the statute/regulation dialects to one vocabulary before routing
    // (`section-e` → `section`), so the regulation track is the #8 track.
    const className = normalizeElawsClass(block.className)
    const { text } = block

    if (className === 'section' && block.anchor === undefined) {
      // e-laws gives substantive sections a BKn bookmark; an anchorless
      // `section` block is an "Omitted" / administrative provision (short title,
      // coming-into-force, "amends other Acts") that the table of contents also
      // skips. It carries no citable text, so the parser drops it — keeping the
      // parsed section set equal to the ToC completeness oracle.
      continue
    }

    if (className === 'partnum') {
      const number = partNumberFromText(text)
      if (number === undefined) continue
      const part: BuildNode = {
        kind: 'part',
        label: number,
        path: pathFor([{ kind: 'part', label: number }]),
        text: '',
        children: [],
      }
      childOfRoot.push(part)
      cursor.part = part
      cursor.section = undefined
      cursor.subsection = undefined
      cursor.clause = undefined
      resetDefinitions()
      continue
    }

    if (className === 'schedule') {
      // A Schedule is a top-level division the ToC lists as a section row
      // ("Schedule"), so it is modelled as a section to match the completeness
      // oracle; its heading text (after the coordinate) is its operative text.
      const label = scheduleLabel(text)
      if (label === null) continue
      const headingRest = scheduleRest(text)
      const schedule: BuildNode = {
        kind: 'section',
        label,
        path: pathFor([{ kind: 'section', label }]),
        text: headingRest,
        children: [],
      }
      childOfRoot.push(schedule)
      cursor.part = undefined
      cursor.section = schedule
      cursor.subsection = undefined
      cursor.clause = undefined
      resetDefinitions()
      continue
    }

    if (className === 'headingx') {
      // A `headingx` inside a Schedule is a table title ("Table 1 Sitework"); it
      // opens a subsection under the Schedule that the following data rows nest
      // under. A `headingx` that is not a table title is a sub-heading we leave
      // to the surrounding section's text, so it is skipped here.
      const label = tableTitle(text)
      if (label === null || !cursor.section) continue
      const titleRest = tableTitleRest(text)
      const tableSub: BuildNode = {
        kind: 'subsection',
        label,
        path: pathFor([...cursor.section.path.segments, { kind: 'subsection', label }]),
        text: titleRest,
        children: [],
      }
      cursor.section.children.push(tableSub)
      cursor.subsection = tableSub
      cursor.clause = undefined
      cursor.definition = undefined
      cursor.table = tableSub
      cursor.tableRowIndex = 0
      continue
    }

    if (className === DATATABLE_CLASS) {
      foldTable(block.innerHtml)
      continue
    }

    if (className === 'section') {
      const split = splitSectionNumber(text)
      if (!split) continue
      const parentChildren = cursor.part ? cursor.part.children : childOfRoot
      const baseSegments = cursor.part ? [{ kind: 'part' as const, label: cursor.part.label }] : []
      const section: BuildNode = {
        kind: 'section',
        label: split.label,
        path: pathFor([...baseSegments, { kind: 'section', label: split.label }]),
        text: '',
        children: [],
      }
      parentChildren.push(section)
      cursor.section = section
      cursor.subsection = undefined
      cursor.clause = undefined
      resetDefinitions()

      // A section opening "(1) …" carries its first subsection inline; one with
      // no leading marker carries its own operative text directly.
      const inline = splitSubsection(split.rest)
      if (inline) {
        const subsection: BuildNode = {
          kind: 'subsection',
          label: inline.label,
          path: pathFor([...section.path.segments, { kind: 'subsection', label: inline.label }]),
          text: inline.rest,
          children: [],
        }
        section.children.push(subsection)
        cursor.subsection = subsection
      } else {
        section.text = split.rest
      }
      continue
    }

    if (SUBSECTION_CLASSES.has(className)) {
      const split = splitSubsection(text)
      if (!split || !cursor.section) continue
      const subsection: BuildNode = {
        kind: 'subsection',
        label: split.label,
        path: pathFor([
          ...cursor.section.path.segments,
          { kind: 'subsection', label: split.label },
        ]),
        text: split.rest,
        children: [],
      }
      cursor.section.children.push(subsection)
      cursor.subsection = subsection
      cursor.clause = undefined
      resetDefinitions()
      continue
    }

    if (CLAUSE_CLASSES.has(className)) {
      const split = splitClause(text)
      // An active definition (e.g. "landlord includes,") owns the enumerated
      // (a)/(b) items that follow it; otherwise the clause hangs off the
      // subsection (or the section, for a section with no subsection).
      const host = cursor.definition ?? cursor.subsection ?? cursor.section
      if (!split || !host) continue
      const clause: BuildNode = {
        kind: 'clause',
        label: split.label,
        path: pathFor([...host.path.segments, { kind: 'clause', label: split.label }]),
        text: split.rest,
        children: [],
      }
      host.children.push(clause)
      cursor.clause = clause
      continue
    }

    if (SUBPARA_CLASSES.has(className)) {
      const split = splitSubparagraph(text)
      const host = cursor.clause ?? cursor.subsection ?? cursor.section
      if (!split || !host) continue
      const subpara: BuildNode = {
        kind: 'clause',
        label: split.label,
        path: pathFor([...host.path.segments, { kind: 'clause', label: split.label }]),
        text: split.rest,
        children: [],
      }
      host.children.push(subpara)
      continue
    }

    if (DEFINITION_CLASSES.has(className)) {
      // Each definition is its own citable clause node, labelled by its defined
      // term, holding its verbatim text. A continuation line carrying no leading
      // term (e.g. the tail of a definition split by an interruption) gets a
      // positional `def-N` label so it stays addressable without inventing a
      // term it does not have.
      const host = cursor.subsection ?? cursor.section
      if (!host) continue
      cursor.definitionIndex += 1
      const term = definitionTerm(text)
      const label = term ?? `def-${cursor.definitionIndex}`
      const definition: BuildNode = {
        kind: 'clause',
        label,
        path: pathFor([...host.path.segments, { kind: 'clause', label }]),
        text,
        children: [],
      }
      host.children.push(definition)
      cursor.definition = definition
      cursor.clause = definition
      continue
    }

    // headnote, footnoteLeft, Pnote, table, and chrome are not operative text.
  }

  const tree = freezeTree(documentId, input.title, childOfRoot)
  const text = collectText(childOfRoot)
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
