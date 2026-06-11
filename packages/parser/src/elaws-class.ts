/**
 * e-laws class-name normalization.
 *
 * e-laws renders unilingual STATUTES with bare structural classes (`section`,
 * `subsection`, `clause`, `partnum`, `TOCid`) and bilingual REGULATIONS with the
 * identical vocabulary under an English-variant `-e` suffix (`section-e`,
 * `subsection-e`, …). The two dialects are structurally the same tree; only the
 * class spelling differs. Folding the suffix away here lets the one #8 parser and
 * its table-of-contents oracle (ADR 0004, deterministic track) cover both Acts
 * and both regulations without a forked code path or a second block vocabulary.
 *
 * The normalization is a pure, total string function — a parser input is a
 * function of the source bytes alone, so the dialect a block belongs to never
 * leaks past this module.
 */

/**
 * Strips the e-laws English-variant `-e` suffix from a `<p>` class name so the
 * statute and regulation dialects collapse to one vocabulary (`section-e` →
 * `section`). A class without the suffix is returned unchanged, so statute
 * classes pass through untouched.
 */
export function normalizeElawsClass(className: string): string {
  return className.endsWith('-e') ? className.slice(0, -2) : className
}
