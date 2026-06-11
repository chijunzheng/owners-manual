import { type DocumentTree, parseDocumentTree } from '@owners-manual/core'
import { describe, expect, it } from 'vitest'

import { type ParsedDocument, pathKey, textOf } from './parsed-document.js'

/**
 * A ParsedDocument is the deterministic statute parse: the existing strict,
 * addressing-only document tree (issue #7) PLUS a sidecar map of operative text
 * keyed by citable path. Text lives beside the tree, never inside its `.strict()`
 * nodes — the tree stays "one artifact, two consumers" (retrieval + cite
 * grading, both addressing-only, per CONTEXT.md), and the parser's text output
 * powers the text-fidelity and round-trip asserts.
 */
const tree: DocumentTree = parseDocumentTree({
  kind: 'document',
  documentId: 'RTA',
  label: 'Residential Tenancies Act, 2006',
  children: [
    {
      kind: 'section',
      label: '1',
      children: [{ kind: 'subsection', label: '2', children: [] }],
    },
  ],
})

const parsed: ParsedDocument = {
  tree,
  text: new Map([
    [pathKey({ documentId: 'RTA', segments: [{ kind: 'section', label: '1' }] }), 'The purposes.'],
    [
      pathKey({
        documentId: 'RTA',
        segments: [
          { kind: 'section', label: '1' },
          { kind: 'subsection', label: '2' },
        ],
      }),
      'Subsection (1) does not apply.',
    ],
  ]),
}

describe('pathKey', () => {
  it('serializes a citable path to a stable, collision-free string', () => {
    expect(pathKey({ documentId: 'RTA', segments: [{ kind: 'section', label: '1' }] })).toBe(
      'RTA|section:1',
    )
  })

  it('distinguishes a clause "1" from a subsection "1" at the same depth', () => {
    const asSubsection = pathKey({
      documentId: 'RTA',
      segments: [{ kind: 'subsection', label: '1' }],
    })
    const asClause = pathKey({ documentId: 'RTA', segments: [{ kind: 'clause', label: '1' }] })
    expect(asSubsection).not.toBe(asClause)
  })

  it('round-trips through the keys used in a text map', () => {
    expect(
      parsed.text.has(pathKey({ documentId: 'RTA', segments: [{ kind: 'section', label: '1' }] })),
    ).toBe(true)
  })
})

describe('textOf', () => {
  it('returns the operative text addressed by a citable path', () => {
    expect(textOf(parsed, { documentId: 'RTA', segments: [{ kind: 'section', label: '1' }] })).toBe(
      'The purposes.',
    )
  })

  it('returns the deepest node text for a nested path', () => {
    expect(
      textOf(parsed, {
        documentId: 'RTA',
        segments: [
          { kind: 'section', label: '1' },
          { kind: 'subsection', label: '2' },
        ],
      }),
    ).toBe('Subsection (1) does not apply.')
  })

  it('returns undefined for a path with no text', () => {
    expect(
      textOf(parsed, { documentId: 'RTA', segments: [{ kind: 'section', label: '999' }] }),
    ).toBeUndefined()
  })
})
