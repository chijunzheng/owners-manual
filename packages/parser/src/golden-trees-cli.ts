/**
 * `golden:trees` entry point: render every {@link GOLDEN_TREE_SOURCES} document
 * into `evals/fixtures/golden/trees/`. Corpus inputs must already be fetched
 * (`npm run corpus:fetch -- --only <id>`); a missing input is a hard error
 * naming the fetch command, never a silent skip.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GOLDEN_TREE_SOURCES, renderGoldenTree } from './golden-trees.js'

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const treesDir = join(repoRoot, 'evals', 'fixtures', 'golden', 'trees')

for (const source of GOLDEN_TREE_SOURCES) {
  const inputPath = join(repoRoot, source.inputFile)
  let html: string
  try {
    html = readFileSync(inputPath, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `golden:trees cannot read ${source.inputFile} (${detail}). ` +
        `Corpus inputs are gitignored — run: npm run corpus:fetch -- --only ${source.id}`,
    )
  }
  const outputPath = join(treesDir, source.outputFile)
  writeFileSync(outputPath, renderGoldenTree(source, html))
  process.stdout.write(`wrote ${source.outputFile}\n`)
}
