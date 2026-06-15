/**
 * Pinned runtime config for the stuffing arms (#18): the product model (held
 * constant with naive-rag and the agent — ADR 0005), the Vertex context-caching
 * flag, and the per-million-token cost rates the honest cost-per-question is
 * computed from. Pinning the rates here (not hardcoding them in the arm) keeps
 * the cost reproducible and the model string in one place — a swap is a config
 * change, like `NAIVE_RAG_PIPELINE_CONFIG.runtime`.
 *
 * Also owns `buildChunksForArm`: the pure chunk-router the live CLI binds into
 * `StuffServiceDeps.chunksForArm`. It stuffs the whole corpus for `stuff` (fixed
 * canonical document order) and the oracle-routed subset for `stuff-oracle`,
 * always in canonical document order so the two arms' shared documents stuff in
 * the SAME order (no spurious prefix-order difference between the arms).
 *
 * The rate values are Vertex list pricing for the pinned Gemini flagship as
 * verified at build time (ADR 0005: "Verify … Vertex long-context and
 * context-caching pricing"); they are pinned reference values, not secrets.
 */

import { z } from 'zod'

import { type CorpusChunk } from './chunk-corpus.js'
import { type CorpusTag } from './corpus-tag.js'
import { NAIVE_RAG_PIPELINE_CONFIG } from './pipeline-config.js'
import { type StuffArm, type StuffCostRates } from './stuff.js'

/** The pinned cost-rate and caching half of the stuff runtime config. */
export const stuffRuntimeConfigSchema = z
  .object({
    /** Held constant with the other arms (ADR 0005). */
    model: z.string().min(1),
    /** Stuffed runs ride Vertex context caching on the fixed corpus prefix. */
    contextCaching: z.boolean(),
    costRates: z
      .object({
        inputPerMTok: z.number().nonnegative(),
        cachedInputPerMTok: z.number().nonnegative(),
        outputPerMTok: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict()

export interface StuffRuntimeConfig {
  readonly model: string
  readonly contextCaching: boolean
  readonly costRates: StuffCostRates
}

/**
 * The pinned stuff runtime config. The model mirrors the naive-rag runtime model
 * (one product model across arms); context caching is on; the rates are the
 * verified Vertex list rates for that model (cached input billed at the cache
 * read discount, strictly ≤ the uncached input rate).
 */
export const STUFF_RUNTIME_CONFIG: StuffRuntimeConfig = {
  model: NAIVE_RAG_PIPELINE_CONFIG.runtime.model,
  contextCaching: true,
  costRates: {
    inputPerMTok: 1.25,
    cachedInputPerMTok: 0.31,
    outputPerMTok: 10.0,
  },
}

export interface BuildChunksForArmOptions {
  /** The corpus document ids in fixed canonical order. */
  readonly documentIds: readonly string[]
  /** Each document's chunks, in in-document order (built once by the CLI). */
  readonly chunksByDocument: ReadonlyMap<string, readonly CorpusChunk[]>
  /** The corpus a document belongs to. */
  readonly corpusOfDocument: (documentId: string) => string
}

/**
 * Build the `chunksForArm` resolver: `stuff` concatenates every document's chunks
 * in canonical order; `stuff-oracle` keeps only documents whose corpus is in the
 * oracle-supplied set, in the SAME canonical order. Documents with no chunks are
 * skipped silently (an empty document is not a routing error).
 */
export function buildChunksForArm(
  options: BuildChunksForArmOptions,
): (arm: StuffArm, corpora?: readonly CorpusTag[]) => readonly CorpusChunk[] {
  const { documentIds, chunksByDocument, corpusOfDocument } = options
  return (arm, corpora) => {
    const wanted = arm === 'stuff-oracle' && corpora ? new Set<string>(corpora) : undefined
    return documentIds
      .filter((id) => wanted === undefined || wanted.has(corpusOfDocument(id)))
      .flatMap((id) => chunksByDocument.get(id) ?? [])
  }
}
