/**
 * Deterministic extraction of e-laws embedded data tables.
 *
 * e-laws renders genuine tabular provisions (O. Reg. 516/06's "useful life of
 * work" Schedule, for instance) as HTML `<table>` elements whose cells are
 * `<p class="table-e">` paragraphs. The #7 document tree carries no table kind,
 * so the parser folds a data table into addressable item nodes — one citable
 * unit per data row (ADR 0004, deterministic track). This module is the recovery
 * half: it slices a `<table>` into a row grid of decoded cell texts, and tells a
 * data table apart from the one big layout `<table>` e-laws wraps its table of
 * contents in. The fold of that grid into tree nodes lives in the parser, so the
 * recovery stays a pure, total function of the table HTML.
 */

import { htmlFragmentToText } from './html-text.js'

/** Matches each `<tr>…</tr>` row of a table. */
const ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
/** Matches each `<td>`/`<th>` cell within a row. */
const CELL_RE = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi

/**
 * True when a `<table>` is the e-laws table-of-contents layout wrapper rather
 * than a data table. The table of contents is the only table whose cells carry
 * `TOCid`/`TOCpartCenter` anchors, so their presence is an unambiguous tell.
 */
export function isLayoutTable(tableHtml: string): boolean {
  return /\bclass\s*=\s*["']TOC(?:id|partCenter)/i.test(tableHtml)
}

/**
 * Slices a `<table>` into rows of decoded cell texts, in document order. Each
 * cell is run through {@link htmlFragmentToText} so its text is decoded and
 * whitespace-collapsed identically to every other parsed fragment, keeping the
 * table cells comparable under the text-fidelity assert. A table with no rows
 * yields an empty list rather than throwing.
 */
export function extractTableRows(tableHtml: string): string[][] {
  const rows: string[][] = []
  for (const rowMatch of tableHtml.matchAll(ROW_RE)) {
    const rowHtml = rowMatch[1] ?? ''
    const cells: string[] = []
    for (const cellMatch of rowHtml.matchAll(CELL_RE)) {
      cells.push(htmlFragmentToText(cellMatch[1] ?? ''))
    }
    rows.push(cells)
  }
  return rows
}
