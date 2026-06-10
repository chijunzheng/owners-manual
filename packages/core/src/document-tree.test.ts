import { describe, expect, it } from 'vitest'

import {
  type DocumentTree,
  citablePathOf,
  formatCitablePath,
  parseDocumentTree,
  walkTree,
} from './document-tree.js'

/**
 * A hand-written sample document tree — a slice of the RTA shaped exactly like
 * a deterministic statute parse would emit: Part → section → subsection →
 * clause. Acceptance criterion: the schema validates this and every node
 * carries a citable path.
 */
const sampleTree: DocumentTree = {
  kind: 'document',
  documentId: 'RTA',
  label: 'RTA',
  children: [
    {
      kind: 'part',
      label: 'V',
      children: [
        {
          kind: 'section',
          label: '49',
          children: [
            {
              kind: 'subsection',
              label: '1',
              children: [
                { kind: 'clause', label: 'a', children: [] },
                { kind: 'clause', label: 'b', children: [] },
              ],
            },
          ],
        },
      ],
    },
  ],
}

describe('parseDocumentTree', () => {
  it('validates a hand-written sample tree (Part → section → subsection → clause)', () => {
    const parsed = parseDocumentTree(sampleTree)
    expect(parsed.documentId).toBe('RTA')
    expect(parsed.kind).toBe('document')
  })

  it('rejects a tree whose root is not a document node', () => {
    const bad = { ...sampleTree, kind: 'section' as const }
    expect(() => parseDocumentTree(bad)).toThrow()
  })

  it('rejects a node with an empty label', () => {
    const bad = {
      ...sampleTree,
      children: [{ kind: 'section' as const, label: '', children: [] }],
    }
    expect(() => parseDocumentTree(bad)).toThrow()
  })

  it('rejects a node with an unknown kind', () => {
    const bad = {
      ...sampleTree,
      children: [{ kind: 'paragraph', label: '1', children: [] }],
    }
    expect(() => parseDocumentTree(bad as unknown)).toThrow()
  })

  it('rejects the root when it is missing its children key', () => {
    const bad = { kind: 'document', documentId: 'RTA', label: 'RTA' }
    expect(() => parseDocumentTree(bad as unknown)).toThrow()
  })

  it('rejects a child node that is missing its children key', () => {
    const bad = {
      ...sampleTree,
      children: [{ kind: 'section', label: '1' }],
    }
    expect(() => parseDocumentTree(bad as unknown)).toThrow()
  })

  it('rejects an unknown key on a node', () => {
    const bad = { ...sampleTree, extra: 1 }
    expect(() => parseDocumentTree(bad as unknown)).toThrow()
  })
})

describe('citable paths on every node', () => {
  it('assigns a citable path to every node in the sample tree', () => {
    const paths: string[] = []
    walkTree(parseDocumentTree(sampleTree), (node, path) => {
      // Acceptance criterion: every node carries a citable path.
      expect(path).toBeDefined()
      expect(path.documentId).toBe('RTA')
      expect(Array.isArray(path.segments)).toBe(true)
      paths.push(formatCitablePath(path))
    })

    // document + part V + s.49 + s.49(1) + s.49(1)(a) + s.49(1)(b) = 6 nodes.
    expect(paths).toHaveLength(6)
    expect(paths).toContain('RTA')
    expect(paths).toContain('RTA / Part V')
    expect(paths).toContain('RTA / Part V / s. 49')
    expect(paths).toContain('RTA / Part V / s. 49 / (1)')
    expect(paths).toContain('RTA / Part V / s. 49 / (1) / (a)')
    expect(paths).toContain('RTA / Part V / s. 49 / (1) / (b)')
  })

  it('derives the citable path of the deepest clause directly', () => {
    const tree = parseDocumentTree(sampleTree)
    const part = tree.children[0]!
    const section = part.children[0]!
    const subsection = section.children[0]!
    const clauseB = subsection.children[1]!

    const path = citablePathOf(tree, clauseB)
    expect(path).not.toBeNull()
    expect(path!.documentId).toBe('RTA')
    expect(path!.segments.map((s) => s.label)).toEqual(['V', '49', '1', 'b'])
    expect(path!.segments.map((s) => s.kind)).toEqual(['part', 'section', 'subsection', 'clause'])
  })
})
