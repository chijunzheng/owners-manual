/**
 * Block tokenizer for HTML5 PROSE pages (Tribunals Ontario LTB guidelines and
 * the ontario.ca rent-increase page).
 *
 * Unlike e-laws block streams, a prose page carries its structure in heading
 * levels and wraps the substantive content in page chrome (navigation, sign-in
 * menus, footers). This pass isolates the main content region, drops the chrome,
 * and slices what remains into an ordered stream of typed blocks — headings
 * (with their level) and text blocks (paragraphs and list items) — the flat
 * substrate the prose parser folds into the #7 document tree. Like the e-laws
 * tokenizer it only classifies and slices; the structural fold lives elsewhere,
 * and every output is a pure function of the source bytes (ADR 0004).
 */

import { htmlFragmentToText } from './html-text.js'

/** A prose block: either a heading (carrying its level) or a text run. */
export interface ProseBlock {
  /** "heading" for `<h1>`–`<h6>`; "text" for a paragraph or list item. */
  readonly kind: 'heading' | 'text'
  /** Heading level 1–6 for a heading; 0 for a text block. */
  readonly level: number
  /** The decoded, whitespace-normalized text of the block. */
  readonly text: string
}

/** Container/chrome elements whose entire subtree is non-content and is removed. */
const CHROME_TAGS = ['script', 'style', 'nav', 'header', 'footer', 'aside', 'form', 'svg', 'button']

/**
 * Class keywords that mark a list/section as page furniture rather than content:
 * the in-page "On this page" table of contents and the footnotes trailer. These
 * carry their own `<li>` text that would otherwise leak into the tree (the
 * heading above them is already dropped for carrying a class), so the whole
 * container is removed.
 */
const CHROME_CLASS_KEYWORDS = ['footnotes', 'toc']

/** Matches the main content region; falls back to the whole body when absent. */
const MAIN_RE = /<main\b[^>]*>([\s\S]*?)<\/main>/i
const ARTICLE_RE = /<article\b[^>]*>([\s\S]*?)<\/article>/i
const BODY_RE = /<body\b[^>]*>([\s\S]*?)<\/body>/i

/** Matches a heading element, capturing its level digit, attributes, and inner HTML. */
const HEADING_RE = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi
/** Matches a paragraph or list item and captures its inner HTML. */
const TEXT_RE = /<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi
/** A `class` attribute, which marks a heading as page furniture, not content. */
const HAS_CLASS_RE = /\bclass\s*=/i

/** Removes every chrome subtree so its text can never reach the block stream. */
function stripChrome(html: string): string {
  let out = html
  for (const tag of CHROME_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ')
    // Void/self-closing forms (e.g. <svg .../>) and unclosed leftovers.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), ' ')
  }
  // Remove furniture lists/sections (in-page ToC, footnotes) by class keyword,
  // matching the OPENING tag's class only so a one-deep container is excised
  // without a brittle balanced-tag parse (these lists do not nest the same tag).
  for (const keyword of CHROME_CLASS_KEYWORDS) {
    for (const tag of ['ul', 'ol', 'section', 'div']) {
      const re = new RegExp(
        `<${tag}\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\b${keyword}\\b[^"']*["'][^>]*>[\\s\\S]*?<\\/${tag}>`,
        'gi',
      )
      out = out.replace(re, ' ')
    }
  }
  return out
}

/**
 * Isolates the substantive content region of a prose page: the `<main>` body if
 * present, else the `<article>`, else the whole `<body>`, else the input. This
 * is what lets the LTB guidelines (no `<main>`) and the ontario.ca page (chrome
 * around a `<main>`) share one extractor.
 */
export function extractContentRegion(html: string): string {
  const main = MAIN_RE.exec(html)
  if (main) return main[1]!
  const article = ARTICLE_RE.exec(html)
  if (article) return article[1]!
  const body = BODY_RE.exec(html)
  if (body) return body[1]!
  return html
}

/** A block tagged with the source offset where it begins, for ordering. */
interface Positioned {
  readonly at: number
  readonly block: ProseBlock
}

/**
 * Tokenizes a prose page into an ordered list of {@link ProseBlock}s. Chrome is
 * stripped first; then headings and text runs in the content region are emitted
 * in document order. A block whose text is empty after decoding is dropped, so
 * the stream carries only substantive content.
 */
export function tokenizeProse(html: string): ProseBlock[] {
  const region = stripChrome(extractContentRegion(html))
  const positioned: Positioned[] = []

  for (const match of region.matchAll(HEADING_RE)) {
    // A class-bearing heading is page furniture (the in-page "On this page"
    // table of contents, a "Footnotes" trailer, a ministry footer); substantive
    // content headings on these pages are classless. Skip the former.
    if (HAS_CLASS_RE.test(match[2] ?? '')) continue
    const text = htmlFragmentToText(match[3] ?? '')
    if (text.length === 0) continue
    positioned.push({
      at: match.index ?? 0,
      block: { kind: 'heading', level: Number.parseInt(match[1]!, 10), text },
    })
  }

  for (const match of region.matchAll(TEXT_RE)) {
    const text = htmlFragmentToText(match[2] ?? '')
    if (text.length === 0) continue
    positioned.push({ at: match.index ?? 0, block: { kind: 'text', level: 0, text } })
  }

  return positioned.sort((a, b) => a.at - b.at).map((entry) => entry.block)
}
