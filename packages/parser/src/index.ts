/**
 * The deterministic statute parser (ADR 0004, deterministic e-laws track).
 *
 * Issue #8 lands the zero-LLM ingestion path for one Act: it parses the
 * Residential Tenancies Act's e-laws HTML into the typed document tree from #7
 * (Part → section → subsection → clause), pairs it with a path-keyed text
 * sidecar, and ships the intrinsic asserts (section completeness vs the table of
 * contents, cite round-trips, text-fidelity diff) plus a golden extraction set
 * of hand-blessed hard sections. Markdown is a derived render for human review,
 * never the source of truth.
 */

export const PACKAGE_NAME = '@owners-manual/parser'

export { type ParseStatuteInput, parseStatute } from './rta-parser.js'

export { type ParsedDocument, pathKey, textOf } from './parsed-document.js'

export { type Block, tokenizeBlocks } from './block-tokenizer.js'

export { htmlFragmentToText } from './html-text.js'

export { type Toc, type TocPart, type TocSection, extractToc } from './toc.js'

export {
  type SectionCompletenessResult,
  type CiteRoundTripResult,
  type TextFidelityResult,
  checkSectionCompleteness,
  checkCiteRoundTrip,
  checkTextFidelity,
} from './intrinsic.js'

export { renderMarkdown } from './render-markdown.js'

export {
  GOLDEN_CATEGORIES,
  type GoldenCategory,
  type GoldenItem,
  loadGoldenExtractionSet,
  parseGoldenItem,
} from './golden/load.js'
