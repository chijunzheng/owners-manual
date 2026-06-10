import { describe, expect, it } from 'vitest'

import {
  CITE_VERDICTS,
  type CiteVerdict,
  matchCite,
  resolvesToNode,
  satisfiesRequirement,
} from './cite-matcher.js'
import { type ConformanceVectors, loadConformanceVectors } from './conformance.js'

const vectors: ConformanceVectors = loadConformanceVectors()

describe('cite-matcher conformance vectors', () => {
  it('loads the committed vector file with at least one case per verdict', () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(4)

    const covered = new Set(vectors.cases.map((c) => c.expected))
    // Every verdict the spec defines must be exercised by at least one vector.
    for (const verdict of CITE_VERDICTS) {
      expect(covered.has(verdict)).toBe(true)
    }
  })

  it.each(vectors.cases.map((c) => [c.id, c] as const))(
    'vector %s yields its expected verdict',
    (_id, vectorCase) => {
      const verdict = matchCite({
        required: vectorCase.required,
        candidate: vectorCase.candidate,
        documents: vectors.documents,
      })
      expect(verdict).toBe(vectorCase.expected)
    },
  )
})

describe('matchCite direct API', () => {
  const documents = vectors.documents

  it('returns "exact" when required and candidate are identical', () => {
    const path = { documentId: 'RTA', segments: [{ kind: 'section' as const, label: '62' }] }
    const verdict: CiteVerdict = matchCite({ required: path, candidate: path, documents })
    expect(verdict).toBe('exact')
  })

  it('returns "unresolvable" for a hallucinated section', () => {
    const verdict = matchCite({
      required: { documentId: 'RTA', segments: [{ kind: 'section', label: '62' }] },
      candidate: { documentId: 'RTA', segments: [{ kind: 'section', label: '404' }] },
      documents,
    })
    expect(verdict).toBe('unresolvable')
  })
})

describe('resolvesToNode', () => {
  const documents = vectors.documents

  it('resolves a real path', () => {
    expect(
      resolvesToNode(
        {
          documentId: 'RTA',
          segments: [
            { kind: 'section', label: '49' },
            { kind: 'subsection', label: '1' },
          ],
        },
        documents,
      ),
    ).toBe(true)
  })

  it('does not resolve a path in an unknown document', () => {
    expect(
      resolvesToNode(
        { documentId: 'NOPE', segments: [{ kind: 'section', label: '1' }] },
        documents,
      ),
    ).toBe(false)
  })

  it('does not resolve a path that overshoots a real leaf', () => {
    expect(
      resolvesToNode(
        {
          documentId: 'RTA',
          segments: [
            { kind: 'section', label: '62' },
            { kind: 'subsection', label: '1' },
            { kind: 'clause', label: 'a' },
          ],
        },
        documents,
      ),
    ).toBe(false)
  })
})

describe('satisfiesRequirement', () => {
  it('treats exact and descendant verdicts as full satisfaction', () => {
    expect(satisfiesRequirement('exact')).toBe(true)
    expect(satisfiesRequirement('descendant-satisfies-ancestor')).toBe(true)
  })

  it('treats partial, no-match, and unresolvable as not satisfied', () => {
    expect(satisfiesRequirement('ancestor-partial')).toBe(false)
    expect(satisfiesRequirement('no-match')).toBe(false)
    expect(satisfiesRequirement('unresolvable')).toBe(false)
  })
})
