/**
 * The deterministic ingestion parsers (ADR 0004, deterministic track).
 *
 * Issue #8 landed the zero-LLM e-laws path for one Act; issue #31 extends it to
 * the rest of the corpus across three source families, all folding into the same
 * #7 document tree (Part → section → subsection → clause) with a path-keyed text
 * sidecar:
 *
 *   - e-laws statutes AND regulations — {@link parseStatute} (the regulation
 *     `-e` class dialect and embedded data tables are handled in one parser);
 *   - HTML5 prose (LTB guidelines, the rent-increase page) — {@link parseProse},
 *     which folds the heading outline into the same tree.
 *
 * The intrinsic asserts adapt per family: section completeness vs the table of
 * contents where one exists ({@link checkSectionCompleteness}), the heading
 * outline where it does not ({@link checkProseCompleteness}), and cite
 * round-trips plus a text-fidelity diff everywhere. Markdown is a derived render
 * for human review, never the source of truth.
 */

export const PACKAGE_NAME = '@owners-manual/parser'

export { type ParseStatuteInput, parseStatute } from './rta-parser.js'

export { type ParseProseInput, parseProse } from './prose-parser.js'

export {
  type CorpusSource,
  type SourceFamily,
  CORPUS_SOURCES,
  parseSource,
  sourceById,
} from './sources.js'

export { type ParsedDocument, pathKey, textOf } from './parsed-document.js'

export { type Block, DATATABLE_CLASS, tokenizeBlocks } from './block-tokenizer.js'

export { type ProseBlock, extractContentRegion, tokenizeProse } from './prose-blocks.js'

export { normalizeElawsClass } from './elaws-class.js'

export { extractTableRows, isLayoutTable } from './tables.js'

export { slugify } from './slug.js'

export { htmlFragmentToText } from './html-text.js'

export { type Toc, type TocPart, type TocSection, extractToc } from './toc.js'

export {
  type SectionCompletenessResult,
  type CiteRoundTripResult,
  type TextFidelityResult,
  type ProseCompletenessResult,
  checkSectionCompleteness,
  checkCiteRoundTrip,
  checkTextFidelity,
  checkProseCompleteness,
} from './intrinsic.js'

export { renderMarkdown } from './render-markdown.js'

export {
  GOLDEN_CATEGORIES,
  type GoldenCategory,
  type GoldenItem,
  loadGoldenExtractionSet,
  parseGoldenItem,
} from './golden/load.js'
