/**
 * The injected PDF-read seam for the offline enrichment track (ADR 0004).
 *
 * PDF sources (policy wordings, declarations, BYOD) are converted by Claude's
 * native PDF reading through the same Agent SDK adapter as the rest of the
 * enrichment track, then cross-checked by a deterministic `pdftotext` coverage
 * diff so no clause can silently vanish. That SDK credit window opens later and
 * no provider keys live in this checkout, so every PDF read goes through the
 * narrow {@link PdfReader} interface and the real adapter is injected only where
 * credit exists. CI runs against {@link fakePdfReader}: deterministic,
 * network-free, and call-recording, mirroring {@link fakeClaudeClient}.
 *
 * The coverage diff is the fidelity oracle for PDFs (issue #13: "No LLM ever
 * re-authors source text"): every clause the deterministic `pdftotext`
 * extraction saw must land in the tree, and the tree must carry no text the
 * extraction never produced. The real adapter plugs into this contract WITHOUT
 * changing it.
 */

import { createHash } from 'node:crypto'

import { parseDocumentTree, walkTree } from '@owners-manual/core'
import { pathKey, type ParsedDocument } from '@owners-manual/parser'

/** One PDF to read: its document id, human title, and raw bytes. */
export interface PdfReadRequest {
  readonly documentId: string
  readonly title: string
  readonly pdfBytes: Uint8Array
}

/**
 * The minimal PDF-read surface the enrichment track depends on. `model` is the
 * pinned model string that flows into pipeline config and the build hash. The
 * future real adapter (Claude native PDF reading via the Agent SDK) implements
 * this; nothing else about it ships now.
 */
export interface PdfReader {
  /** The pinned PDF-reading model string (recorded in build metadata). */
  readonly model: string
  /** Read one PDF into the shared {@link ParsedDocument} representation. */
  readPdf(request: PdfReadRequest): Promise<ParsedDocument>
}

/** A scripted responder: maps a request to the ParsedDocument it would yield. */
export type FakePdfResponder = (request: PdfReadRequest) => ParsedDocument

/** Construction options for the fake reader. */
export interface FakePdfReaderOptions {
  /** The pinned model string the fake reports; defaults to a test sentinel. */
  readonly model?: string
  /** Optional canned responder; defaults to a deterministic one-section tree. */
  readonly responder?: FakePdfResponder
}

/** A fake reader that also exposes the requests it received. */
export interface FakePdfReader extends PdfReader {
  /** Every request received, in call order. */
  readonly calls: readonly PdfReadRequest[]
}

/**
 * The default responder: a minimal one-section tree whose operative text derives
 * deterministically from the documentId, so identical requests yield identical
 * documents (the property tree-hash caching relies on under test) and distinct
 * documentIds yield distinct text.
 */
function defaultResponder(request: PdfReadRequest): ParsedDocument {
  const digest = createHash('sha256').update(request.documentId, 'utf8').digest('hex').slice(0, 16)
  return {
    tree: {
      kind: 'document',
      label: request.documentId,
      documentId: request.documentId,
      children: [{ kind: 'section', label: '1', children: [] }],
    },
    text: new Map([[`${request.documentId}|section:1`, `fake pdf clause ${digest}`]]),
  }
}

/**
 * Builds a deterministic, call-recording fake PDF reader. With no responder it
 * returns a minimal one-section tree whose text is a stable digest of the
 * documentId, so the offline track is exercised end to end without a live model.
 */
export function fakePdfReader(options: FakePdfReaderOptions = {}): FakePdfReader {
  const model = options.model ?? 'fake-pdf-reader-0'
  const responder = options.responder ?? defaultResponder
  const calls: PdfReadRequest[] = []

  return {
    model,
    calls,
    async readPdf(request) {
      calls.push(request)
      return responder(request)
    },
  }
}

/** Collects every path key the tree addresses, document order. */
function treePathKeys(parsed: ParsedDocument): Set<string> {
  const keys = new Set<string>()
  walkTree(parsed.tree, (_node, path) => {
    keys.add(pathKey(path))
  })
  return keys
}

/**
 * Validates a PDF-read result against the same contract every parsed document
 * honours: the tree passes core's zod schema, and every text-sidecar key
 * addresses a real node of that tree. Throws a descriptive error on violation;
 * returns the input unchanged (never mutates).
 */
export function validatePdfRead(parsed: ParsedDocument): ParsedDocument {
  // Throws a ZodError with the structural violation if the tree is malformed.
  parseDocumentTree(parsed.tree)

  const known = treePathKeys(parsed)
  for (const key of parsed.text.keys()) {
    if (!known.has(key)) {
      throw new Error(
        `PDF read produced text for "${key}", which addresses no node of the document tree`,
      )
    }
  }
  return parsed
}

/** The result of the deterministic `pdftotext` coverage diff. */
export interface PdfCoverageResult {
  /** True iff both diff arrays are empty: the read is faithful to extraction. */
  readonly ok: boolean
  /** Reference lines no tree node covers — clauses that silently vanished. */
  readonly missingFromTree: readonly string[]
  /** Tree text absent from the reference — text the LLM "authored". */
  readonly extraInTree: readonly string[]
}

/** Collapse runs of whitespace to single spaces and trim. */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * THE `pdftotext` coverage diff: a pure, deterministic comparison of a parsed
 * document against the reference text `pdftotext` produced (injected as a string;
 * never invoked here). Both sides are whitespace-normalized first.
 *
 * (a) Re-authoring detector: every text node of the tree must occur as a
 *     substring of the normalized reference; nodes that do not are collected as
 *     `extraInTree` (text the LLM authored that the deterministic extraction
 *     never saw).
 * (b) Vanished-clause detector: the reference is split into non-empty lines
 *     (pre-normalization), and any line whose normalized form is contained in no
 *     tree node's normalized text is collected as `missingFromTree`.
 *
 * `ok` is true iff both arrays are empty.
 */
export function checkPdfCoverage(parsed: ParsedDocument, referenceText: string): PdfCoverageResult {
  const normalizedReference = normalizeWhitespace(referenceText)
  const treeTexts = [...parsed.text.values()]
  const normalizedTreeTexts = treeTexts.map(normalizeWhitespace)

  const extraInTree = treeTexts.filter((text) => {
    const normalized = normalizeWhitespace(text)
    return normalized.length > 0 && !normalizedReference.includes(normalized)
  })

  const missingFromTree = referenceText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => {
      const normalizedLine = normalizeWhitespace(line)
      return !normalizedTreeTexts.some((text) => text.includes(normalizedLine))
    })

  return {
    ok: extraInTree.length === 0 && missingFromTree.length === 0,
    missingFromTree,
    extraInTree,
  }
}
