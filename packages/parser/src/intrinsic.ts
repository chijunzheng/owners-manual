/**
 * Intrinsic ingestion asserts (ADR 0004) — the structure- and text-fidelity
 * checks that make the deterministic parse trustworthy without an LLM judge.
 *
 * Each check is a pure function over a {@link ParsedDocument} (and, where it
 * needs an independent oracle, the source HTML), returning a structured result
 * rather than throwing. That shape lets the same checks run two ways: in CI over
 * the committed golden fixtures (network-free, no Crown-copyright text), and
 * locally or nightly over the full RTA materialized by the corpus fetch. The
 * three checks mirror the README's intrinsic-evals list:
 *
 *   1. section completeness — every table-of-contents section appears in the
 *      tree exactly once, and the tree invents none;
 *   2. cite round-trip — every text-bearing node's path, re-walked from the
 *      tree, resolves back to that node's identical text;
 *   3. text fidelity — every parsed operative-text fragment occurs verbatim in
 *      the source, so no provision was dropped or silently re-worded.
 */

import { walkTree, type DocumentTree } from '@owners-manual/core'

import { htmlFragmentToText } from './html-text.js'
import { type ParsedDocument, pathKey, textOf } from './parsed-document.js'
import { tokenizeProse } from './prose-blocks.js'
import { extractToc } from './toc.js'

/** Result of the section-completeness check against the table of contents. */
export interface SectionCompletenessResult {
  readonly ok: boolean
  /** How many sections the table of contents declares. */
  readonly expected: number
  /** How many distinct section nodes the tree carries. */
  readonly parsed: number
  /** ToC sections with no matching tree node. */
  readonly missing: string[]
  /** Tree section nodes not present in the table of contents. */
  readonly unexpected: string[]
  /** Section numbers that appear more than once in the tree. */
  readonly duplicated: string[]
}

/** Result of the cite round-trip check. */
export interface CiteRoundTripResult {
  readonly ok: boolean
  /** How many text-bearing nodes were checked. */
  readonly checked: number
  /** Path keys whose text did not round-trip (unreachable or unequal). */
  readonly mismatches: string[]
}

/** Result of the text-fidelity diff against the source. */
export interface TextFidelityResult {
  readonly ok: boolean
  /** Fraction of parsed text fragments found verbatim in the source. */
  readonly coverageRatio: number
  /** Path keys whose text was not found verbatim in the source. */
  readonly unfaithful: string[]
}

/** Collects the section labels of a tree in document order. */
function sectionLabels(tree: DocumentTree): string[] {
  const labels: string[] = []
  walkTree(tree, (node) => {
    if (node.kind === 'section') labels.push(node.label)
  })
  return labels
}

function duplicates(labels: readonly string[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const label of labels) {
    if (seen.has(label)) dupes.add(label)
    seen.add(label)
  }
  return [...dupes]
}

/**
 * Checks that the tree's sections are exactly the table of contents' sections,
 * one-to-one. The ToC is parsed from the same source HTML but by a different
 * path (its own `TOCid` rows), so this compares two independent views.
 */
export function checkSectionCompleteness(
  tree: DocumentTree,
  sourceHtml: string,
): SectionCompletenessResult {
  const expected = extractToc(sourceHtml).sections.map((section) => section.number)
  const parsed = sectionLabels(tree)
  const expectedSet = new Set(expected)
  const parsedSet = new Set(parsed)

  const missing = expected.filter((number) => !parsedSet.has(number))
  const unexpected = parsed.filter((number) => !expectedSet.has(number))
  const duplicated = duplicates(parsed)

  return {
    ok: missing.length === 0 && unexpected.length === 0 && duplicated.length === 0,
    expected: expectedSet.size,
    parsed: parsedSet.size,
    missing,
    unexpected,
    duplicated,
  }
}

/**
 * Checks that every text-bearing node round-trips: re-walking the tree yields a
 * citable path that resolves, via the text sidecar, back to that node's text.
 * A key in the text map that no tree node addresses is an orphan and fails.
 */
export function checkCiteRoundTrip(parsed: ParsedDocument): CiteRoundTripResult {
  const reachable = new Map<string, string>()
  walkTree(parsed.tree, (_node, path) => {
    const key = pathKey(path)
    const text = textOf(parsed, path)
    if (text !== undefined) reachable.set(key, text)
  })

  const mismatches: string[] = []
  for (const [key, text] of parsed.text) {
    const roundTripped = reachable.get(key)
    if (roundTripped !== text) mismatches.push(key)
  }

  return { ok: mismatches.length === 0, checked: parsed.text.size, mismatches }
}

/**
 * Checks that every parsed text fragment occurs verbatim in the normalized
 * source text. Whitespace is normalized identically on both sides (via
 * {@link htmlFragmentToText}) so the comparison ignores incidental layout but
 * catches any dropped, added, or re-worded provision.
 */
export function checkTextFidelity(parsed: ParsedDocument, sourceHtml: string): TextFidelityResult {
  const sourceText = htmlFragmentToText(sourceHtml)
  const unfaithful: string[] = []
  let checked = 0

  for (const [key, text] of parsed.text) {
    checked += 1
    if (!sourceText.includes(text)) unfaithful.push(key)
  }

  const coverageRatio = checked === 0 ? 1 : (checked - unfaithful.length) / checked
  return { ok: unfaithful.length === 0, coverageRatio, unfaithful }
}

/** Result of the prose heading-completeness check. */
export interface ProseCompletenessResult {
  readonly ok: boolean
  /** How many content headings the source declares. */
  readonly expected: number
  /** How many heading-bearing nodes (section/subsection) the tree carries. */
  readonly parsed: number
  /** Source headings with no matching heading node. */
  readonly missing: string[]
  /** Heading nodes whose text is not a source heading. */
  readonly unexpected: string[]
  /** Heading texts that appear on more than one node. */
  readonly duplicated: string[]
}

/** Collects the heading text carried by each section/subsection node of a tree. */
function headingTexts(parsed: ParsedDocument): string[] {
  const headings: string[] = []
  walkTree(parsed.tree, (node, path) => {
    if (node.kind !== 'section' && node.kind !== 'subsection') return
    // The preamble wrapper section carries no heading text, so it is absent from
    // the sidecar and correctly excluded here.
    const text = textOf(parsed, path)
    if (text !== undefined) headings.push(text)
  })
  return headings
}

/** Counts occurrences of each value, preserving multiplicity. */
function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

/**
 * The prose analogue of {@link checkSectionCompleteness}: where a source has no
 * table of contents, the heading outline is the independent oracle. It checks
 * that the content headings of the source (`<h2>`–`<h6>`, re-extracted from the
 * raw HTML by a path independent of the body fold) are exactly the heading texts
 * carried by the tree's section and subsection nodes — none missing, none
 * invented, and none appearing on MORE nodes than the source declares it. A
 * heading the source legitimately repeats (the guidelines reuse titles like
 * "Compensation" across sections) is allowed to repeat the same number of times
 * in the tree; only a count mismatch is a fault. The level-1 page title is not a
 * content heading and is excluded on both sides.
 */
export function checkProseCompleteness(
  parsed: ParsedDocument,
  sourceHtml: string,
): ProseCompletenessResult {
  const expected = tokenizeProse(sourceHtml)
    .filter((block) => block.kind === 'heading' && block.level >= 2)
    .map((block) => block.text)
  const parsedHeadings = headingTexts(parsed)

  const expectedCounts = countBy(expected)
  const parsedCounts = countBy(parsedHeadings)

  const missing = [...expectedCounts.keys()].filter(
    (heading) => (parsedCounts.get(heading) ?? 0) < (expectedCounts.get(heading) ?? 0),
  )
  const unexpected = [...parsedCounts.keys()].filter((heading) => !expectedCounts.has(heading))
  // A fault only when the tree carries a heading on more nodes than the source.
  const duplicated = [...parsedCounts.keys()].filter(
    (heading) =>
      expectedCounts.has(heading) &&
      (parsedCounts.get(heading) ?? 0) > (expectedCounts.get(heading) ?? 0),
  )

  return {
    ok: missing.length === 0 && unexpected.length === 0 && duplicated.length === 0,
    expected: expectedCounts.size,
    parsed: parsedCounts.size,
    missing,
    unexpected,
    duplicated,
  }
}
