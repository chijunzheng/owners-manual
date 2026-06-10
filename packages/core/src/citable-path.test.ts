import { describe, expect, it } from 'vitest'

import {
  type CitablePath,
  citablePathsEqual,
  isProperAncestor,
  isProperDescendant,
  parseCitablePath,
} from './citable-path.js'

const sec49: CitablePath = {
  documentId: 'RTA',
  segments: [{ kind: 'section', label: '49' }],
}

const sec49sub1: CitablePath = {
  documentId: 'RTA',
  segments: [
    { kind: 'section', label: '49' },
    { kind: 'subsection', label: '1' },
  ],
}

const sec49sub1clA: CitablePath = {
  documentId: 'RTA',
  segments: [
    { kind: 'section', label: '49' },
    { kind: 'subsection', label: '1' },
    { kind: 'clause', label: 'a' },
  ],
}

const sec50: CitablePath = {
  documentId: 'RTA',
  segments: [{ kind: 'section', label: '50' }],
}

describe('parseCitablePath', () => {
  it('parses and validates a well-formed citable path', () => {
    const parsed = parseCitablePath(sec49sub1clA)
    expect(parsed.documentId).toBe('RTA')
    expect(parsed.segments).toHaveLength(3)
  })

  it('rejects a citable path with an empty documentId', () => {
    expect(() => parseCitablePath({ documentId: '', segments: [] })).toThrow()
  })

  it('rejects a segment with an unknown kind', () => {
    expect(() =>
      parseCitablePath({
        documentId: 'RTA',
        segments: [{ kind: 'paragraph', label: '1' }],
      } as unknown),
    ).toThrow()
  })
})

describe('citablePathsEqual', () => {
  it('is true for identical paths', () => {
    expect(citablePathsEqual(sec49sub1, { ...sec49sub1 })).toBe(true)
  })

  it('is false for different documents at the same coordinates', () => {
    expect(citablePathsEqual(sec49, { ...sec49, documentId: 'DECLARATION' })).toBe(false)
  })

  it('is false for sibling sections', () => {
    expect(citablePathsEqual(sec49, sec50)).toBe(false)
  })
})

describe('isProperAncestor / isProperDescendant', () => {
  it('treats a section as a proper ancestor of its subsection', () => {
    expect(isProperAncestor(sec49, sec49sub1)).toBe(true)
    expect(isProperDescendant(sec49sub1, sec49)).toBe(true)
  })

  it('treats a section as a proper ancestor of a deep clause', () => {
    expect(isProperAncestor(sec49, sec49sub1clA)).toBe(true)
    expect(isProperDescendant(sec49sub1clA, sec49)).toBe(true)
  })

  it('is not its own ancestor or descendant', () => {
    expect(isProperAncestor(sec49, sec49)).toBe(false)
    expect(isProperDescendant(sec49, sec49)).toBe(false)
  })

  it('does not relate siblings', () => {
    expect(isProperAncestor(sec49, sec50)).toBe(false)
    expect(isProperDescendant(sec49, sec50)).toBe(false)
  })

  it('does not relate paths across documents even when coordinates prefix-match', () => {
    const otherDoc: CitablePath = { ...sec49sub1, documentId: 'DECLARATION' }
    expect(isProperAncestor(sec49, otherDoc)).toBe(false)
    expect(isProperDescendant(otherDoc, sec49)).toBe(false)
  })

  it('requires segment kinds to agree, not just labels', () => {
    // Same labels, but the candidate calls the second segment a clause, not a
    // subsection — these address different nodes, so neither contains the other.
    const mislabeled: CitablePath = {
      documentId: 'RTA',
      segments: [
        { kind: 'section', label: '49' },
        { kind: 'clause', label: '1' },
      ],
    }
    expect(isProperAncestor(sec49, mislabeled)).toBe(true)
    expect(isProperDescendant(mislabeled, sec49sub1)).toBe(false)
  })
})
