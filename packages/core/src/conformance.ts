/**
 * Loader for the cross-language cite-matcher conformance vectors.
 *
 * There is ONE committed vector file — `conformance/cite-matcher-vectors.json`
 * — and two suites that must agree on it: this TypeScript library and the
 * Python eval grader. This module reads that exact file from disk and validates
 * its shape with zod, so a malformed or drifted vector set fails loudly rather
 * than silently skewing a verdict.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { citablePathSchema } from './citable-path.js'
import { type DocumentTree, documentTreeSchema } from './document-tree.js'
import { CITE_VERDICTS } from './cite-matcher.js'

/** Absolute path to the single committed conformance-vector file. */
export const CONFORMANCE_VECTORS_PATH = fileURLToPath(
  new URL('../conformance/cite-matcher-vectors.json', import.meta.url),
)

const documentEntrySchema = z
  .object({
    documentId: z.string().min(1),
    title: z.string().optional(),
    tree: documentTreeSchema,
  })
  .strip()

const caseSchema = z
  .object({
    id: z.string().min(1),
    describe: z.string().optional(),
    required: citablePathSchema,
    candidate: citablePathSchema,
    expected: z.enum(CITE_VERDICTS),
  })
  .strip()

const conformanceVectorsSchema = z
  .object({
    version: z.number().int().min(1),
    documents: z.array(documentEntrySchema),
    cases: z.array(caseSchema).min(1),
  })
  .strip()

export type ConformanceCase = z.infer<typeof caseSchema>

export interface ConformanceVectors {
  version: number
  documents: DocumentTree[]
  cases: ConformanceCase[]
}

/** Read, parse, and validate the committed conformance vectors. */
export function loadConformanceVectors(
  path: string = CONFORMANCE_VECTORS_PATH,
): ConformanceVectors {
  const raw = readFileSync(path, 'utf8')
  const parsed = conformanceVectorsSchema.parse(JSON.parse(raw))
  return {
    version: parsed.version,
    documents: parsed.documents.map((entry) => entry.tree),
    cases: parsed.cases,
  }
}
