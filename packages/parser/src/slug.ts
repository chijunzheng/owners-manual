/**
 * Deterministic slug labels for prose headings.
 *
 * A prose source (an LTB guideline, the rent-increase page) has no section
 * numbers, so a heading node needs a stable, human-meaningful label for its
 * citable path. A slug of the heading text is exactly that: "General Approach of
 * the Board" → "general-approach-of-the-board". The slug is a pure function of
 * the heading, so the same page always yields the same citable paths (ADR 0004,
 * content-addressable parse). Collisions within one parent are disambiguated by
 * the parser with a numeric suffix, not here.
 */

/**
 * Converts heading text to a lowercase hyphen slug: letters and digits survive,
 * every other run becomes a single hyphen, and leading/trailing hyphens are
 * trimmed. An empty or symbol-only heading yields the fallback "section".
 */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    // Drop combining marks so accented headings slug to their base letters.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'section'
}
