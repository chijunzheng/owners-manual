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

/**
 * The section number sits in a leading `<strong>…</strong>`; e.g. "5.1".
 * Statutes print it bare ("5 "); regulations print a trailing period ("5. "),
 * so a single decorative period before the required whitespace is optional. The
 * inner `(?:\.\d+)*` still binds digit-period-digit runs like "5.1", so only a
 * period directly before whitespace is treated as decoration.
 */
const SECTION_NUMBER_RE = /^\s*(\d+(?:\.\d+)*)\.?\s+/

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

/**
 * A Schedule division opens with the word "Schedule", optionally followed by a
 * coordinate that is a number ("Schedule 1") or a single capital letter
 * ("Schedule A") — and then either whitespace or end. The coordinate alternative
 * is case-sensitive (a single `[A-Z]`) so a following title word like "Useful"
 * is never mistaken for the coordinate.
 */
const SCHEDULE_RE = /^[Ss]chedule(?:\s+(\d+(?:\.\d+)?|[A-Z]))?(?=\s|$)/

/**
 * Recovers a Schedule division's label from its heading block. The e-laws table
 * of contents lists an unnumbered schedule as the bare word "Schedule" and a
 * numbered one as "Schedule 1"; the body label must match that ToC coordinate so
 * the completeness oracle lines up. Returns null for a non-schedule line.
 */
export function scheduleLabel(text: string): string | null {
  const match = SCHEDULE_RE.exec(text.trim())
  if (!match) return null
  return match[1] ? `Schedule ${match[1]}` : 'Schedule'
}

/** Strips a Schedule coordinate prefix, leaving the heading's title text. */
export function scheduleRest(text: string): string {
  return text.trim().replace(SCHEDULE_RE, '').trim()
}

/**
 * A table title block opens with the word "Table", optionally followed by a
 * coordinate ("Table 1 Sitework") and optionally nothing more (a bare "Table",
 * as in O. Reg. 48/01's forms table). The `\b` after "Table" stops it matching a
 * word like "Tabletop". The coordinate, when present, is a number or a single
 * capital letter and must be followed by whitespace or end.
 */
const TABLE_TITLE_RE = /^[Tt]able\b(?:\s+(\d+(?:\.\d+)?|[A-Z])(?=\s|$))?/

/**
 * Recovers a table title's coordinate from a `headingx` block: "Table 1" from
 * "Table 1 Sitework", or the bare "Table" when the title carries no number.
 * Returns null when the heading does not open with the word "Table".
 */
export function tableTitle(text: string): string | null {
  const match = TABLE_TITLE_RE.exec(text.trim())
  if (!match) return null
  return match[1] ? `Table ${match[1].toUpperCase()}` : 'Table'
}

/** Strips a table-title coordinate prefix, leaving the table's title text. */
export function tableTitleRest(text: string): string {
  return text.trim().replace(TABLE_TITLE_RE, '').trim()
}
