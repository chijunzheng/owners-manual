/**
 * Deterministic HTML-fragment → plain-text extraction.
 *
 * The deterministic statute track (ADR 0004) recovers the operative legal text
 * of each citable unit from e-laws HTML with no LLM and no DOM dependency: the
 * markup the e-laws renderer emits inside a content paragraph is a small, fixed
 * vocabulary (inline emphasis, anchors, line breaks, a handful of entities), so
 * a pure tag-strip + entity-decode is auditable and reproducible. Text fidelity
 * and cite round-trips are only as trustworthy as this function, so it is kept
 * small, total, and free of any "cleaning" that could silently alter wording —
 * it normalizes whitespace and decodes entities, nothing more.
 */

/**
 * Named HTML entities decoded literally. The first group is the structural set
 * e-laws output uses; the typographic set (en/em dashes, curly quotes, ellipsis)
 * is added for the HTML5 prose pages (LTB guidelines, the rent-increase page),
 * which write these as named entities where the e-laws renderer emits the Unicode
 * character directly. Decoding is applied identically to the parsed text and to
 * the source side of the fidelity comparison, so the diff stays consistent.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
}

/** Decodes one entity body (the text between `&` and `;`) or returns `null`. */
function decodeEntityBody(body: string): string | null {
  if (body.startsWith('#x') || body.startsWith('#X')) {
    const code = Number.parseInt(body.slice(2), 16)
    return Number.isNaN(code) ? null : String.fromCodePoint(code)
  }
  if (body.startsWith('#')) {
    const code = Number.parseInt(body.slice(1), 10)
    return Number.isNaN(code) ? null : String.fromCodePoint(code)
  }
  return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)
    ? (NAMED_ENTITIES[body] as string)
    : null
}

/** Replaces every recognised entity; unknown entities are left verbatim. */
function decodeEntities(input: string): string {
  return input.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    const decoded = decodeEntityBody(body)
    return decoded ?? whole
  })
}

/**
 * Collapses any run of whitespace to a single space and trims the ends, so two
 * fragments differing only in incidental layout whitespace render to identical
 * operative text. `\s` already covers ASCII whitespace and U+00A0 (the decoded
 * `&nbsp;`), so one run match handles every layout gap.
 */
function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

/**
 * Strips inline markup from an HTML fragment and returns its decoded,
 * whitespace-normalized text. `<br>` becomes a space (so list-like line breaks
 * do not weld words together); all other tags are removed, keeping their
 * content.
 */
export function htmlFragmentToText(fragment: string): string {
  const withBreaksAsSpaces = fragment.replace(/<br\s*\/?>/gi, ' ')
  const withoutTags = withBreaksAsSpaces.replace(/<[^>]*>/g, '')
  return collapseWhitespace(decodeEntities(withoutTags))
}
