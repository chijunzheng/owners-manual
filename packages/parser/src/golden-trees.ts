/**
 * Golden-set tree wiring (issue #9): renders the document trees the golden-item
 * loader resolves required cites against, for committing under
 * `evals/fixtures/golden/trees/`.
 *
 * Only the TREE is exported — the addressing skeleton of kind/label nodes —
 * never the text sidecar. Statute trees are addressing-only (section numbers),
 * so no Crown-copyright operative text is committed; the raw HTML stays
 * gitignored under corpus/raw/ per the corpus rules.
 */

import { parseDocumentTree } from '@owners-manual/core'

import { parseFixture } from './fixtures.js'
import { parseSource } from './sources.js'

/** One tree to export: where its HTML lives and what file the loader globs. */
export interface GoldenTreeSource {
  /** Corpus source id or fixture id — also the exported tree's documentId. */
  readonly id: string
  /** Routes parsing: manifest sources vs designed fixtures. */
  readonly kind: 'corpus' | 'fixture'
  /** Input HTML path, repo-root relative. Corpus inputs are gitignored. */
  readonly inputFile: string
  /** Output filename under evals/fixtures/golden/trees/. */
  readonly outputFile: string
}

/**
 * Exactly the documents the v0 golden items cite: the real RTA and Reg 516/06
 * for statute cites, the designed lease and declaration for void-clause cites.
 * Growing the golden set to new documents (#22) means adding entries here and
 * re-running `npm run golden:trees`.
 */
export const GOLDEN_TREE_SOURCES: readonly GoldenTreeSource[] = [
  {
    id: 'rta-2006',
    kind: 'corpus',
    inputFile: 'corpus/raw/tenancy/rta-2006.html',
    outputFile: 'rta-2006.tree.json',
  },
  {
    id: 'reg-516-06',
    kind: 'corpus',
    inputFile: 'corpus/raw/tenancy/reg-516-06.html',
    outputFile: 'reg-516-06.tree.json',
  },
  {
    id: 'fixture-lease',
    kind: 'fixture',
    inputFile: 'corpus/fixtures/tenancy/lease.html',
    outputFile: 'fixture-lease.tree.json',
  },
  {
    id: 'fixture-declaration',
    kind: 'fixture',
    inputFile: 'corpus/fixtures/governing/declaration.html',
    outputFile: 'fixture-declaration.tree.json',
  },
]

/**
 * Parses one registered document's HTML and renders its tree as pretty-printed
 * JSON (trailing newline, 2-space indent — the committed-fixture diff format).
 * The tree is re-validated through core's schema before rendering, so a parser
 * regression can never write a tree the Python loader would reject.
 */
export function renderGoldenTree(source: GoldenTreeSource, html: string): string {
  const parsed =
    source.kind === 'corpus' ? parseSource(source.id, html) : parseFixture(source.id, html)
  const tree = parseDocumentTree(parsed.tree)
  return `${JSON.stringify(tree, null, 2)}\n`
}
