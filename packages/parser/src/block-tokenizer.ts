/**
 * Block tokenizer for e-laws HTML.
 *
 * The e-laws renderer emits one `<p class="…">` element per structural unit
 * (a section, a subsection, a clause, a heading, an amendment note), and embeds
 * genuine data tables as `<table>` elements. This pass slices the document into
 * an ordered stream of classified blocks — the flat substrate the parser folds
 * into a tree. It deliberately does not interpret structure: it classifies each
 * `<p>` by its CSS class and surfaces each data `<table>` as one `datatable`
 * block (so the parser can fold its rows without the cell paragraphs leaking
 * into the stream). Keeping classification and structural assembly in separate
 * passes keeps both small and independently testable.
 */

import { htmlFragmentToText } from './html-text.js'
import { isLayoutTable } from './tables.js'

/** Synthetic class for a data `<table>` surfaced as a single block. */
export const DATATABLE_CLASS = 'datatable'

/** One classified block from the e-laws body, in document order. */
export interface Block {
  /** The CSS class that types the block; {@link DATATABLE_CLASS} for a data table. */
  readonly className: string
  /** The raw inner HTML (between `<p>` tags, or the whole `<table>` for a data table). */
  readonly innerHtml: string
  /** The decoded, whitespace-normalized text of the block. */
  readonly text: string
  /** The e-laws bookmark name (`BKn`) anchored in the block, if any. */
  readonly anchor?: string
}

/** Matches each `<p …>…</p>` element, capturing its attributes and inner HTML. */
const PARAGRAPH_RE = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi

/** Matches each top-level `<table …>…</table>` element. */
const TABLE_RE = /<table\b[^>]*>[\s\S]*?<\/table>/gi

/** Extracts the `class` attribute value (single- or double-quoted). */
const CLASS_RE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i

/** Extracts an e-laws bookmark name from an `<a name="BKn">` anchor. */
const ANCHOR_RE = /<a\b[^>]*\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/i

function attributeValue(match: RegExpMatchArray | null): string | undefined {
  if (!match) return undefined
  return match[1] ?? match[2]
}

/** A half-open `[start, end)` span of the source a table occupies. */
interface Span {
  readonly start: number
  readonly end: number
  readonly html: string
}

/** An emitted block tagged with the source offset where it begins, for ordering. */
interface Positioned {
  readonly at: number
  readonly block: Block
}

/** Finds every top-level `<table>` span (used both to emit and to mask). */
function tableSpans(html: string): Span[] {
  const spans: Span[] = []
  for (const match of html.matchAll(TABLE_RE)) {
    const start = match.index ?? 0
    spans.push({ start, end: start + match[0].length, html: match[0] })
  }
  return spans
}

/**
 * Tokenizes the HTML into an ordered list of {@link Block}s. Each classified
 * `<p>` becomes a block; each genuine data `<table>` becomes one
 * {@link DATATABLE_CLASS} block. Paragraphs without a class are chrome and are
 * skipped; paragraphs nested inside a DATA table are its cells and are
 * suppressed (the table block already carries them). The table-of-contents
 * layout `<table>` is left transparent: its `TOCid`/`TOCpartCenter` cell
 * paragraphs stay in the stream so the ToC oracle can read them, and the body
 * parser ignores them as it always has. The result is in document order.
 */
export function tokenizeBlocks(html: string): Block[] {
  // Only DATA tables mask their inner cells; the ToC layout table stays
  // transparent so `extractToc` can still read its rows from the block stream.
  const spans = tableSpans(html)
  const dataSpans = spans.filter((span) => !isLayoutTable(span.html))
  const insideTable = (at: number): boolean =>
    dataSpans.some((span) => at >= span.start && at < span.end)

  const positioned: Positioned[] = []

  for (const match of html.matchAll(PARAGRAPH_RE)) {
    const at = match.index ?? 0
    if (insideTable(at)) continue
    const className = attributeValue(CLASS_RE.exec(match[1] ?? ''))
    if (className === undefined) continue
    const innerHtml = match[2] ?? ''
    const anchor = attributeValue(ANCHOR_RE.exec(innerHtml))
    positioned.push({
      at,
      block: {
        className,
        innerHtml,
        text: htmlFragmentToText(innerHtml),
        ...(anchor !== undefined ? { anchor } : {}),
      },
    })
  }

  for (const span of dataSpans) {
    positioned.push({
      at: span.start,
      block: { className: DATATABLE_CLASS, innerHtml: span.html, text: '' },
    })
  }

  return positioned.sort((a, b) => a.at - b.at).map((entry) => entry.block)
}
