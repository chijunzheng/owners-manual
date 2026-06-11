/**
 * Block tokenizer for e-laws HTML.
 *
 * The e-laws renderer emits one `<p class="…">` element per structural unit
 * (a section, a subsection, a clause, a heading, an amendment note). This pass
 * slices the document into that ordered stream of classified blocks — the flat
 * substrate the RTA parser folds into a tree. It deliberately does not interpret
 * structure: it classifies each `<p>` by its CSS class, exposes the inner HTML
 * and its decoded text, and records the e-laws bookmark anchor (`BKn`) when one
 * is present. Keeping classification and structural assembly in separate passes
 * keeps both small and independently testable.
 */

import { htmlFragmentToText } from './html-text.js'

/** One classified `<p class="…">` block from the e-laws body, in document order. */
export interface Block {
  /** The CSS class that types the block (e.g. "section", "subsection", "definition"). */
  readonly className: string
  /** The raw HTML between the `<p>` tags, markup intact. */
  readonly innerHtml: string
  /** The decoded, whitespace-normalized text of the block. */
  readonly text: string
  /** The e-laws bookmark name (`BKn`) anchored in the block, if any. */
  readonly anchor?: string
}

/** Matches each `<p …>…</p>` element, capturing its attributes and inner HTML. */
const PARAGRAPH_RE = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi

/** Extracts the `class` attribute value (single- or double-quoted). */
const CLASS_RE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i

/** Extracts an e-laws bookmark name from an `<a name="BKn">` anchor. */
const ANCHOR_RE = /<a\b[^>]*\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/i

function attributeValue(match: RegExpMatchArray | null): string | undefined {
  if (!match) return undefined
  return match[1] ?? match[2]
}

/**
 * Tokenizes the HTML into an ordered list of {@link Block}s, one per classified
 * `<p>`. Paragraphs without a `class` attribute are chrome (navigation, layout)
 * and are skipped, so the stream contains only typed content blocks.
 */
export function tokenizeBlocks(html: string): Block[] {
  const blocks: Block[] = []
  for (const match of html.matchAll(PARAGRAPH_RE)) {
    const attributes = match[1] ?? ''
    const innerHtml = match[2] ?? ''
    const className = attributeValue(CLASS_RE.exec(attributes))
    if (className === undefined) continue
    const anchor = attributeValue(ANCHOR_RE.exec(innerHtml))
    blocks.push({
      className,
      innerHtml,
      text: htmlFragmentToText(innerHtml),
      ...(anchor !== undefined ? { anchor } : {}),
    })
  }
  return blocks
}
