import { describe, expect, it } from 'vitest'

import type { ParsedDocument } from '@owners-manual/parser'

import {
  checkPdfCoverage,
  fakePdfReader,
  validatePdfRead,
  type PdfReader,
  type PdfReadRequest,
} from './pdf-track.js'

/**
 * Slice D of issue #13: the OFFLINE CONTRACT for the PDF-read track (ADR 0004).
 * PDF sources are read by Claude's native PDF reading through the Agent SDK and
 * cross-checked by a deterministic pdftotext coverage diff so no clause can
 * silently vanish. No provider keys live in this checkout (the SDK credit window
 * opens later), so the whole track is built against an injected {@link PdfReader}
 * seam and a deterministic fake. These tests pin the contract the real adapter
 * will plug into WITHOUT changing it: fake determinism + call recording + model
 * pinning, output validation, and the coverage-diff pure function — the fidelity
 * oracle for PDFs ("No LLM ever re-authors source text").
 */

// Build synthetic ParsedDocuments inline, mirroring tree-hash.test.ts: the tree
// is addressing-only (kind/label/children) and the operative text lives in a
// parallel path-keyed sidecar map.
const tree = (documentId: string, children: unknown[] = []) => ({
  kind: 'document' as const,
  label: documentId,
  documentId,
  children: children as never,
})

const doc = (
  documentId: string,
  text: Array<[string, string]>,
  children: unknown[] = [],
): ParsedDocument => ({
  tree: tree(documentId, children),
  text: new Map(text),
})

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values)

describe('fakePdfReader', () => {
  it('is a PdfReader', () => {
    const reader: PdfReader = fakePdfReader()
    expect(typeof reader.model).toBe('string')
    expect(typeof reader.readPdf).toBe('function')
  })

  it('reports the pinned model string it was constructed with', () => {
    expect(fakePdfReader().model).toBe('fake-pdf-reader-0')
    expect(fakePdfReader({ model: 'pdf-test-0' }).model).toBe('pdf-test-0')
  })

  it('returns a deterministic ParsedDocument for the same request', async () => {
    const reader = fakePdfReader()
    const request: PdfReadRequest = {
      documentId: 'DECL',
      title: 'Declaration',
      pdfBytes: bytes(1, 2, 3),
    }
    const a = await reader.readPdf(request)
    const b = await reader.readPdf(request)
    expect(a).toEqual(b)
  })

  it('derives the default tree text deterministically from the documentId', async () => {
    const fromA = await fakePdfReader().readPdf({
      documentId: 'A',
      title: 't',
      pdfBytes: bytes(0),
    })
    const fromB = await fakePdfReader().readPdf({
      documentId: 'B',
      title: 't',
      pdfBytes: bytes(0),
    })
    expect(fromA.tree.documentId).toBe('A')
    expect(fromB.tree.documentId).toBe('B')
    expect([...fromA.text.values()]).not.toEqual([...fromB.text.values()])
  })

  it('returns a default ParsedDocument that passes its own validation', async () => {
    const parsed = await fakePdfReader().readPdf({
      documentId: 'DECL',
      title: 'Declaration',
      pdfBytes: bytes(9),
    })
    expect(() => validatePdfRead(parsed)).not.toThrow()
  })

  it('records every request in call order', async () => {
    const reader = fakePdfReader()
    await reader.readPdf({ documentId: 'one', title: 't', pdfBytes: bytes(1) })
    await reader.readPdf({ documentId: 'two', title: 't', pdfBytes: bytes(2) })
    expect(reader.calls.map((c) => c.documentId)).toEqual(['one', 'two'])
  })

  it('records the exact request fields received', async () => {
    const reader = fakePdfReader()
    const request: PdfReadRequest = {
      documentId: 'DECL',
      title: 'Declaration',
      pdfBytes: bytes(7, 8),
    }
    await reader.readPdf(request)
    expect(reader.calls[0]).toEqual(request)
  })

  it('can be scripted with a canned responder keyed off the request', async () => {
    const scripted = doc('SCRIPTED', [['SCRIPTED|section:1', 'canned clause']])
    const reader = fakePdfReader({ responder: () => scripted })
    const parsed = await reader.readPdf({
      documentId: 'ignored',
      title: 't',
      pdfBytes: bytes(0),
    })
    expect(parsed).toBe(scripted)
  })
})

describe('validatePdfRead', () => {
  it('accepts a well-formed ParsedDocument and returns it unchanged', () => {
    const parsed = doc(
      'DECL',
      [['DECL|section:1', 'The corporation shall maintain the common elements']],
      [{ kind: 'section', label: '1', children: [] }],
    )
    expect(validatePdfRead(parsed)).toBe(parsed)
  })

  it('never mutates the input', () => {
    const parsed = doc(
      'DECL',
      [['DECL|section:1', 'text']],
      [{ kind: 'section', label: '1', children: [] }],
    )
    const before = JSON.stringify({
      tree: parsed.tree,
      text: [...parsed.text.entries()],
    })
    validatePdfRead(parsed)
    const after = JSON.stringify({
      tree: parsed.tree,
      text: [...parsed.text.entries()],
    })
    expect(after).toBe(before)
  })

  it('rejects a tree that fails the core schema', () => {
    // Root kind is not "document": the schema's superRefine must reject it.
    const broken: ParsedDocument = {
      tree: {
        kind: 'section',
        label: '1',
        documentId: 'DECL',
        children: [],
      } as never,
      text: new Map(),
    }
    expect(() => validatePdfRead(broken)).toThrow()
  })

  it('rejects a text-map key with no corresponding tree node', () => {
    // The text sidecar addresses a section "9" the tree never declares.
    const parsed = doc(
      'DECL',
      [['DECL|section:9', 'orphaned text']],
      [{ kind: 'section', label: '1', children: [] }],
    )
    expect(() => validatePdfRead(parsed)).toThrow(/DECL\|section:9/)
  })

  it('accepts text keyed to the document root itself', () => {
    const parsed = doc('DECL', [['DECL', 'preamble text']])
    expect(() => validatePdfRead(parsed)).not.toThrow()
  })
})

describe('checkPdfCoverage', () => {
  const reference = [
    'The corporation shall maintain the common elements.',
    'Each owner shall pay common expenses monthly.',
  ].join('\n')

  it('passes when every clause lands in the tree and nothing is invented', () => {
    const parsed = doc('DECL', [
      ['DECL|section:1', 'The corporation shall maintain the common elements.'],
      ['DECL|section:2', 'Each owner shall pay common expenses monthly.'],
    ])
    const result = checkPdfCoverage(parsed, reference)
    expect(result).toEqual({ ok: true, missingFromTree: [], extraInTree: [] })
  })

  it('flags a reference clause that never lands in the tree', () => {
    const parsed = doc('DECL', [
      ['DECL|section:1', 'The corporation shall maintain the common elements.'],
    ])
    const result = checkPdfCoverage(parsed, reference)
    expect(result.ok).toBe(false)
    expect(result.missingFromTree).toEqual(['Each owner shall pay common expenses monthly.'])
    expect(result.extraInTree).toEqual([])
  })

  it('flags a tree node carrying text absent from the reference (re-authoring)', () => {
    const parsed = doc('DECL', [
      ['DECL|section:1', 'The corporation shall maintain the common elements.'],
      ['DECL|section:2', 'Each owner shall pay common expenses monthly.'],
      ['DECL|section:3', 'Pets weighing over 25 pounds are prohibited.'],
    ])
    const result = checkPdfCoverage(parsed, reference)
    expect(result.ok).toBe(false)
    expect(result.extraInTree).toEqual(['Pets weighing over 25 pounds are prohibited.'])
    expect(result.missingFromTree).toEqual([])
  })

  it('treats whitespace-only differences as a match', () => {
    const messyReference = '  The   corporation\tshall   maintain\n\nthe common  elements.  '
    const parsed = doc('DECL', [
      ['DECL|section:1', 'The corporation shall maintain the\nthe common elements.'],
    ])
    // The clause text differs from the reference only by collapsed whitespace.
    const tidy = doc('DECL', [['DECL|section:1', 'The corporation shall maintain']])
    const result = checkPdfCoverage(tidy, '   The   corporation\n shall  maintain ')
    expect(result.ok).toBe(true)
    expect(result.missingFromTree).toEqual([])
    expect(result.extraInTree).toEqual([])
    // The standalone messy/parsed pair is unrelated; keep the assert above honest.
    expect(messyReference).toContain('corporation')
    expect(parsed.text.size).toBe(1)
  })

  it('covers a short reference line via a longer multi-space tree node', () => {
    // A tree node may aggregate several reference lines: a short reference line
    // is still covered when it is a whitespace-normalized substring of a node,
    // and the node's surplus words are fine because the whole node is itself a
    // substring of the reference, so nothing is flagged as invented.
    const parsed = doc('DECL', [
      ['DECL|section:1', 'each   owner   shall   pay    common     expenses'],
    ])
    const reference = ['each owner shall', 'pay common expenses'].join('\n')
    const result = checkPdfCoverage(parsed, reference)
    expect(result.missingFromTree).toEqual([])
    expect(result.extraInTree).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('ignores blank reference lines when computing coverage', () => {
    const parsed = doc('DECL', [['DECL|section:1', 'only clause here']])
    const referenceWithBlanks = '\n\n   only clause here  \n\n\n'
    const result = checkPdfCoverage(parsed, referenceWithBlanks)
    expect(result).toEqual({ ok: true, missingFromTree: [], extraInTree: [] })
  })

  it('flags a vanished DUPLICATE clause — occurrence counts, not distinct lines', () => {
    // The reference carries the same clause twice (legal boilerplate repeats);
    // the tree kept only one occurrence. A distinct-line containment check would
    // call this covered; the occurrence-counting detector must not.
    const repeated = 'Each owner shall insure the improvements to the unit.'
    const referenceWithDuplicate = [repeated, 'Another clause entirely.', repeated].join('\n')
    const parsed = doc('DECL', [
      ['DECL|section:1', repeated],
      ['DECL|section:2', 'Another clause entirely.'],
    ])
    const result = checkPdfCoverage(parsed, referenceWithDuplicate)
    expect(result.ok).toBe(false)
    expect(result.missingFromTree).toEqual([repeated])
  })

  it('passes when duplicate reference clauses all land in the tree', () => {
    const repeated = 'Each owner shall insure the improvements to the unit.'
    const referenceWithDuplicate = [repeated, repeated].join('\n')
    const parsed = doc('DECL', [
      ['DECL|section:1', repeated],
      ['DECL|section:2', repeated],
    ])
    const result = checkPdfCoverage(parsed, referenceWithDuplicate)
    expect(result).toEqual({ ok: true, missingFromTree: [], extraInTree: [] })
  })

  it('flags a DUPLICATED tree clause that appears only once in the reference', () => {
    // The mirror image of the vanished-duplicate case: the reader emitted the
    // same clause twice while pdftotext saw it once. Containment alone passes
    // both copies; occurrence capping must flag the surplus as invented.
    const clause = 'The corporation shall maintain the common elements.'
    const parsed = doc('DECL', [
      ['DECL|section:1', clause],
      ['DECL|section:2', clause],
    ])
    const result = checkPdfCoverage(parsed, clause)
    expect(result.ok).toBe(false)
    expect(result.extraInTree).toEqual([clause])
    expect(result.missingFromTree).toEqual([])
  })

  it('passes vacuously for an empty reference and an empty tree text', () => {
    const parsed = doc('DECL', [])
    const result = checkPdfCoverage(parsed, '')
    expect(result).toEqual({ ok: true, missingFromTree: [], extraInTree: [] })
  })

  it('flags invented tree text even when the reference is empty', () => {
    const parsed = doc('DECL', [['DECL|section:1', 'invented clause']])
    const result = checkPdfCoverage(parsed, '   \n  ')
    expect(result.ok).toBe(false)
    expect(result.extraInTree).toEqual(['invented clause'])
    expect(result.missingFromTree).toEqual([])
  })
})
