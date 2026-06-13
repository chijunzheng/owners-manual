import { describe, expect, it } from 'vitest'

import { walkTree, type DocumentTree } from '@owners-manual/core'
import { parseFixture, pathKey, textOf, type ParsedDocument } from '@owners-manual/parser'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { citableUnitChunker, type Chunker } from './chunk.js'
import { hierarchyChunker } from './hierarchy-chunker.js'

/**
 * The hierarchy chunker is #14's real chunker, replacing the `citable-unit`
 * reference stand-in. ADR 0004 / CONTEXT.md pin its correctness criterion as a
 * LEGAL, not semantic, one: chunk boundaries MUST coincide with citable units.
 * "Coincide" is the crisp, unit-testable contract pinned here:
 *
 *   - every chunk's boundary is a real, text-bearing citable unit of the tree
 *     (no chunk straddles two units, none lands on a structure-only node);
 *   - every text-bearing citable unit yields exactly one chunk (none dropped,
 *     none duplicated);
 *   - so the SET of chunk boundaries equals the SET of text-bearing citable
 *     units — a bijection.
 *
 * Where it differs from the reference chunker is content, never boundary: the
 * hierarchy chunker prepends the ancestor hierarchy path to each chunk's
 * embeddable text (so a bare "(1) … is void" is findable by its section/Part
 * context), but the chunk still ADDRESSES exactly its citable unit. The boundary
 * bijection is asserted against the committed designed fixtures (real trees,
 * network-free in CI) — the legal-correctness gate the issue calls out.
 */

const here = dirname(fileURLToPath(import.meta.url))
/** Repo root from packages/enrichment/src. */
const repoRoot = join(here, '..', '..', '..')

function readFixture(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8')
}

/** Parse a committed designed fixture into its tree + text sidecar. */
function fixture(id: string, relPath: string): ParsedDocument {
  return parseFixture(id, readFixture(relPath))
}

/** The set of path-keys of every TEXT-BEARING citable unit in a parsed doc. */
function textBearingUnitKeys(parsed: ParsedDocument): Set<string> {
  const keys = new Set<string>()
  walkTree(parsed.tree, (_node, path) => {
    if (textOf(parsed, path) !== undefined) keys.add(pathKey(path))
  })
  return keys
}

/** A tiny synthetic tree with a structure-only Part and nested text units. */
const synthetic: ParsedDocument = {
  tree: {
    kind: 'document',
    label: 'RTA',
    documentId: 'rta-2006',
    children: [
      {
        kind: 'part',
        label: 'II',
        children: [
          { kind: 'section', label: '14', children: [] },
          {
            kind: 'section',
            label: '20',
            children: [
              { kind: 'subsection', label: '1', children: [] },
              { kind: 'subsection', label: '2', children: [] },
            ],
          },
        ],
      },
    ],
  } satisfies DocumentTree,
  // Part II carries no operative text (structure only); s.14 and the two
  // subsections of s.20 do. s.20 itself is a chapeau with no own text here.
  text: new Map([
    ['rta-2006|part:II|section:14', 'No-pet provisions in a tenancy agreement are void.'],
    [
      'rta-2006|part:II|section:20|subsection:1',
      'The landlord is responsible for repair of the rental unit.',
    ],
    ['rta-2006|part:II|section:20|subsection:2', 'This applies even if the tenant knew.'],
  ]),
}

const FIXTURE_LEASE = fixture('fixture-lease', 'corpus/fixtures/tenancy/lease.html')
const FIXTURE_DECLARATION = fixture(
  'fixture-declaration',
  'corpus/fixtures/governing/declaration.html',
)

describe('hierarchyChunker — Chunker contract', () => {
  it('satisfies the Chunker interface with a stable strategy id', () => {
    const chunker: Chunker = hierarchyChunker
    expect(typeof chunker.id).toBe('string')
    expect(chunker.id).toBe('hierarchy-v1')
    expect(typeof chunker.chunk).toBe('function')
  })

  it('is deterministic: two runs produce identical chunk ids and text', () => {
    const a = hierarchyChunker.chunk(synthetic)
    const b = hierarchyChunker.chunk(synthetic)
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id))
    expect(a.map((c) => c.text)).toEqual(b.map((c) => c.text))
  })

  it('namespaces chunk ids by the strategy id (no collision with citable-unit)', () => {
    const [hierarchy] = hierarchyChunker.chunk(synthetic)
    const [reference] = citableUnitChunker.chunk(synthetic)
    expect(hierarchy?.id.startsWith('hierarchy-v1:')).toBe(true)
    expect(hierarchy?.id).not.toBe(reference?.id)
  })
})

describe('hierarchyChunker — boundaries coincide with citable units (synthetic)', () => {
  it('emits one chunk per text-bearing citable unit, in document order', () => {
    const chunks = hierarchyChunker.chunk(synthetic)
    expect(chunks.map((c) => c.citablePathKey)).toEqual([
      'rta-2006|part:II|section:14',
      'rta-2006|part:II|section:20|subsection:1',
      'rta-2006|part:II|section:20|subsection:2',
    ])
  })

  it('never emits a chunk for a structure-only node (Part II has no text)', () => {
    const chunks = hierarchyChunker.chunk(synthetic)
    const keys = chunks.map((c) => c.citablePathKey)
    expect(keys).not.toContain('rta-2006|part:II')
    expect(keys).not.toContain('rta-2006|part:II|section:20')
  })

  it('chunk boundaries equal the text-bearing citable units (a bijection)', () => {
    const chunks = hierarchyChunker.chunk(synthetic)
    const boundaries = new Set(chunks.map((c) => c.citablePathKey))
    expect(boundaries).toEqual(textBearingUnitKeys(synthetic))
    // bijection: no boundary repeated.
    expect(chunks.length).toBe(boundaries.size)
  })
})

describe('hierarchyChunker — content carries the ancestor hierarchy, boundary does not move', () => {
  it("prepends the citable unit's ancestor path to the embeddable text", () => {
    const chunks = hierarchyChunker.chunk(synthetic)
    const subsection = chunks.find(
      (c) => c.citablePathKey === 'rta-2006|part:II|section:20|subsection:1',
    )
    // The boundary still addresses the subsection exactly…
    expect(subsection?.citablePathKey).toBe('rta-2006|part:II|section:20|subsection:1')
    // …but the embeddable text situates it under its Part/section ancestors so
    // a bare "(1) The landlord…" is findable by hierarchy context.
    expect(subsection?.text).toContain('The landlord is responsible for repair')
    expect(subsection?.text.toLowerCase()).toContain('part')
    expect(subsection?.text).toContain('20')
  })

  it('still contains the verbatim operative text of the unit (no re-authoring)', () => {
    const chunks = hierarchyChunker.chunk(synthetic)
    for (const chunk of chunks) {
      const verbatim = synthetic.text.get(chunk.citablePathKey)
      expect(verbatim).toBeDefined()
      expect(chunk.text).toContain(verbatim!)
    }
  })
})

describe('hierarchyChunker — boundary bijection on committed designed fixtures', () => {
  it('lease: chunk boundaries equal the text-bearing citable units exactly', () => {
    const chunks = hierarchyChunker.chunk(FIXTURE_LEASE)
    const boundaries = new Set(chunks.map((c) => c.citablePathKey))
    expect(boundaries).toEqual(textBearingUnitKeys(FIXTURE_LEASE))
    expect(chunks.length).toBe(boundaries.size)
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('declaration: chunk boundaries equal the text-bearing citable units exactly', () => {
    const chunks = hierarchyChunker.chunk(FIXTURE_DECLARATION)
    const boundaries = new Set(chunks.map((c) => c.citablePathKey))
    expect(boundaries).toEqual(textBearingUnitKeys(FIXTURE_DECLARATION))
    expect(chunks.length).toBe(boundaries.size)
  })

  it('every fixture chunk addresses a citable unit that resolves in the tree', () => {
    const chunks = hierarchyChunker.chunk(FIXTURE_LEASE)
    const realKeys = textBearingUnitKeys(FIXTURE_LEASE)
    for (const chunk of chunks) {
      expect(realKeys.has(chunk.citablePathKey)).toBe(true)
    }
  })

  it('agrees with the reference chunker on the boundary SET (content may differ)', () => {
    // Same legal boundaries; the hierarchy chunker differs only in chunk text.
    const hierarchyBoundaries = new Set(
      hierarchyChunker.chunk(FIXTURE_LEASE).map((c) => c.citablePathKey),
    )
    const referenceBoundaries = new Set(
      citableUnitChunker.chunk(FIXTURE_LEASE).map((c) => c.citablePathKey),
    )
    expect(hierarchyBoundaries).toEqual(referenceBoundaries)
  })
})
