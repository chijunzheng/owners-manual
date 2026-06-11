/**
 * Coordinate-marker parsing for e-laws provisions.
 *
 * Each level of an Act announces its coordinate at the head of its text: a
 * section opens with its number, a subsection with `(2)`, a clause with `(a)` or
 * `1.`, a sub-paragraph with `(i)` or `i.`. These helpers extract that
 * coordinate label and return the remaining operative text, deterministically.
 * Splitting the coordinate from the text here keeps the parser's structural
 * logic free of regex detail.
 */

/** A coordinate label plus the text that follows it. */
export interface MarkerSplit {
  /** The coordinate label (e.g. "2", "a", "iv"), without surrounding punctuation. */
  readonly label: string
  /** The operative text after the marker, whitespace-trimmed. */
  readonly rest: string
}

/** The section number sits in a leading `<strong>…</strong>`; e.g. "5.1". */
const SECTION_NUMBER_RE = /^\s*(\d+(?:\.\d+)*)\s+/

/** A parenthesised subsection marker at the head of the text, e.g. "(2)" or "(2.1)". */
const SUBSECTION_RE = /^\(\s*(\d+(?:\.\d+)*)\s*\)\s*/

/** A clause marker: lettered "(a)" / "(a.1)" or numbered "1." paragraph. */
const LETTER_CLAUSE_RE = /^\(\s*([a-z]+(?:\.\d+)?)\s*\)\s*/i
const NUMBER_PARAGRAPH_RE = /^(\d+(?:\.\d+)*)\.\s+/

/** A sub-paragraph marker: roman "(i)" / "i." or further-nested lettered forms. */
const ROMAN_SUBPARA_RE = /^\(?\s*([ivxlcdm]+)\s*[).]\s*/i

function applyHeadMatch(text: string, re: RegExp): MarkerSplit | null {
  const match = re.exec(text)
  if (!match) return null
  return { label: match[1]!, rest: text.slice(match[0].length).trim() }
}

/** Splits the leading section number from a section paragraph's text. */
export function splitSectionNumber(text: string): MarkerSplit | null {
  return applyHeadMatch(text, SECTION_NUMBER_RE)
}

/** Splits a leading `(n)` subsection marker, or returns null if absent. */
export function splitSubsection(text: string): MarkerSplit | null {
  return applyHeadMatch(text, SUBSECTION_RE)
}

/** Splits a leading clause marker — lettered `(a)` or numbered `1.` — or null. */
export function splitClause(text: string): MarkerSplit | null {
  return applyHeadMatch(text, LETTER_CLAUSE_RE) ?? applyHeadMatch(text, NUMBER_PARAGRAPH_RE)
}

/** Splits a leading sub-paragraph marker — roman `(i)` or `i.` — or null. */
export function splitSubparagraph(text: string): MarkerSplit | null {
  return applyHeadMatch(text, ROMAN_SUBPARA_RE)
}

/** A definition opens with its defined term in curly quotes, e.g. “Board”. */
const DEFINITION_TERM_RE = /^“([^”]+)”/

/**
 * Extracts the defined term that opens a definition line (e.g. "Board" from
 * `“Board” means …`), used as the definition node's label. Returns null for a
 * continuation line that carries no leading term.
 */
export function definitionTerm(text: string): string | null {
  const match = DEFINITION_TERM_RE.exec(text.trim())
  return match ? match[1]!.trim() : null
}
