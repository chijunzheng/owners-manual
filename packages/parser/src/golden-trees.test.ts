import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseDocumentTree } from '@owners-manual/core'
import { describe, expect, it } from 'vitest'

import { GOLDEN_TREE_SOURCES, renderGoldenTree } from './golden-trees.js'
import { fixtureById } from './fixtures.js'
import { sourceById } from './sources.js'

/**
 * Issue #9 wiring: the registry of document trees exported for the golden-set
 * loader (evals/fixtures/golden/trees/). Every golden item's required cite must
 * resolve against one of these trees at load time, so the registry pins exactly
 * the documents the v0 items cite: the real RTA and Reg 516/06 (statute cites),
 * and the designed lease + declaration fixtures (void-clause cites).
 */

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..')

describe('GOLDEN_TREE_SOURCES', () => {
  it('exports exactly the documents the v0 golden items cite', () => {
    expect(GOLDEN_TREE_SOURCES.map((entry) => entry.id)).toEqual([
      'rta-2006',
      'reg-516-06',
      'fixture-lease',
      'fixture-declaration',
    ])
  })

  it('routes every id to a registered corpus source or fixture', () => {
    for (const entry of GOLDEN_TREE_SOURCES) {
      const registered = entry.kind === 'corpus' ? sourceById(entry.id) : fixtureById(entry.id)
      expect(registered, entry.id).toBeDefined()
    }
  })

  it('writes each tree as <id>.tree.json so the Python loader globs it', () => {
    for (const entry of GOLDEN_TREE_SOURCES) {
      expect(entry.outputFile).toBe(`${entry.id}.tree.json`)
    }
  })
})

describe('renderGoldenTree', () => {
  it('renders a committed fixture into a parseable document tree', () => {
    const lease = GOLDEN_TREE_SOURCES.find((entry) => entry.id === 'fixture-lease')!
    const html = readFileSync(join(repoRoot, lease.inputFile), 'utf8')

    const rendered = renderGoldenTree(lease, html)
    const tree = parseDocumentTree(JSON.parse(rendered))

    expect(tree.documentId).toBe('fixture-lease')
    expect(tree.children.length).toBeGreaterThan(0)
  })

  it('renders trees only — no operative text leaves the sidecar', () => {
    const lease = GOLDEN_TREE_SOURCES.find((entry) => entry.id === 'fixture-lease')!
    const html = readFileSync(join(repoRoot, lease.inputFile), 'utf8')

    const parsed = JSON.parse(renderGoldenTree(lease, html)) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['children', 'documentId', 'kind', 'label'])
  })

  it('ends with a trailing newline for clean diffs', () => {
    const lease = GOLDEN_TREE_SOURCES.find((entry) => entry.id === 'fixture-lease')!
    const html = readFileSync(join(repoRoot, lease.inputFile), 'utf8')
    expect(renderGoldenTree(lease, html).endsWith('}\n')).toBe(true)
  })
})
