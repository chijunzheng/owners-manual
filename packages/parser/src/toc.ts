/**
 * Table-of-contents extraction — the section-completeness oracle.
 *
 * The intrinsic "every source section lands in the tree exactly once" assert
 * (ADR 0004) needs a view of the document's sections that is independent of the
 * body parse, or it would only be checking the parser against itself. The
 * e-laws table of contents is exactly that independent view: it lists every
 * section number and the Part it falls under, rendered as `TOCid` and
 * `TOCpartCenter` blocks. This module recovers that list so the completeness
 * assert can compare two independently derived sets of section numbers.
 */

import { type Block, tokenizeBlocks } from './block-tokenizer.js'
import { normalizeElawsClass } from './elaws-class.js'
import { htmlFragmentToText } from './html-text.js'

/** A Part as the table of contents declares it. */
export interface TocPart {
  /** The Part's roman-numeral coordinate (e.g. "I", "V.1"). */
  readonly number: string
  /** The Part's name (e.g. "INTRODUCTION"). */
  readonly name: string
}

/** A section as the table of contents declares it. */
export interface TocSection {
  /** The section coordinate (e.g. "1", "5.1", "234"). */
  readonly number: string
  /** The section's marginal heading (e.g. "Purposes of Act"). */
  readonly heading: string
  /** The e-laws bookmark (`BKn`) the body anchor must match. */
  readonly anchor: string
  /** The number of the Part this section falls under. */
  readonly part: string
}

/** The recovered table of contents: ordered Parts and the sections under them. */
export interface Toc {
  readonly parts: TocPart[]
  readonly sections: TocSection[]
}

/** "PART V.1" → "V.1"; tolerates extra whitespace. */
function partNumberFromTitle(title: string): string | undefined {
  const match = /^PART\s+(.+)$/i.exec(title.trim())
  return match ? match[1]!.trim() : undefined
}

/** "1." → "1"; "5.1" → "5.1". A single trailing period is decoration. */
function normalizeSectionNumber(raw: string): string {
  return raw.trim().replace(/\.$/, '')
}

const HREF_RE = /\bhref\s*=\s*(?:"#([^"]*)"|'#([^']*)')/i
const TITLE_RE = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i
/** The Part name trails the closing `</span>` of the anchor wrapper. */
const PART_NAME_RE = /<\/span>\s*([^<]+?)\s*$/

function attr(match: RegExpMatchArray | null): string | undefined {
  return match ? (match[1] ?? match[2]) : undefined
}

function readPart(block: Block): TocPart | undefined {
  const title = attr(TITLE_RE.exec(block.innerHtml))
  const number = title ? partNumberFromTitle(title) : undefined
  if (number === undefined) return undefined
  const nameMatch = PART_NAME_RE.exec(block.innerHtml)
  const name = nameMatch ? htmlFragmentToText(nameMatch[1]!) : ''
  return { number, name }
}

/**
 * Recovers the {@link Toc} from a document's HTML. Walks the classified block
 * stream: `TOCpartCenter` opens a new Part, and each subsequent `TOCid` is a
 * section under it whose heading is the immediately following `table` block.
 */
export function extractToc(html: string): Toc {
  const blocks = tokenizeBlocks(html)
  const parts: TocPart[] = []
  const sections: TocSection[] = []
  let currentPart = ''

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i]!
    // Collapse statute/regulation dialects (`TOCid-e` → `TOCid`) so one oracle
    // reads both. The section-heading cell is likewise `table` or `table-e`.
    const className = normalizeElawsClass(block.className)
    if (className === 'TOCpartCenter') {
      const part = readPart(block)
      if (part) {
        parts.push(part)
        currentPart = part.number
      }
      continue
    }
    if (className === 'TOCid') {
      const anchor = attr(HREF_RE.exec(block.innerHtml))
      const number = normalizeSectionNumber(block.text)
      if (anchor === undefined || number === '') continue
      const next = blocks[i + 1]
      const heading = next && normalizeElawsClass(next.className) === 'table' ? next.text : ''
      sections.push({ number, heading, anchor, part: currentPart })
    }
  }

  return { parts, sections }
}
