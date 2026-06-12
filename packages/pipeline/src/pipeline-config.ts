/**
 * The pinned naive-rag pipeline config — the snapshot the run record measures
 * against (issue #10 AC4: "Run records the manifest + pipeline-config snapshot
 * it measured").
 *
 * ADR 0004 pins corpus builds as content-addressed: `hash(source manifest +
 * pipeline config)`, so two eval numbers are comparable only when both builds
 * are known. This module owns the pipeline-config half of that hash. Every knob
 * that changes what the arm measures lives here and nowhere else:
 *
 *   - the chunker id (#14 swaps `citable-unit` for `hierarchy-v1` — a config
 *     change, not surgery; ADR 0004 / `Chunker`);
 *   - the embedding provider+model (the #14 A/B swaps `voyage-law-2` for
 *     `gemini-embedding-001` — config, not surgery, via the `EmbeddingProvider`
 *     seam);
 *   - the runtime LLM (held constant across all arms — ADR 0005: arm gaps
 *     measure architecture, never model choice);
 *   - the retrieval top-k and the Atlas vector index name.
 *
 * The Gemini model is the current STABLE FLAGSHIP, verified available with a
 * live 1-token call at build time (avoid `-preview`); the pin flows from here
 * into the run record so a model swap is visible in the build hash.
 */

import { createHash } from 'node:crypto'

import { z } from 'zod'

/** The embedding half of the build: provider, model, and vector dimensions. */
export const embeddingConfigSchema = z
  .object({
    /** The provider behind the `EmbeddingProvider` seam (config-swappable at #14). */
    provider: z.enum(['voyage', 'vertex']),
    /** The embedding model string (e.g. `voyage-law-2`). */
    model: z.string().min(1),
    /** The vector dimension the Atlas index is built for. */
    dimensions: z.number().int().positive(),
  })
  .strict()

/** The runtime-LLM half: held constant across arms (ADR 0005). */
export const runtimeConfigSchema = z
  .object({
    provider: z.literal('vertex'),
    /** A stable flagship Gemini model string, no `-preview`. */
    model: z.string().min(1),
  })
  .strict()

/** The retrieval knobs of the naive-rag arm: vector-only top-k. */
export const retrievalConfigSchema = z
  .object({
    topK: z.number().int().positive(),
  })
  .strict()

/** The full pipeline-config snapshot recorded with every run. */
export const pipelineConfigSchema = z
  .object({
    /** The eval arm this config describes. */
    arm: z.literal('naive-rag'),
    /** The {@link Chunker} id — fixed-size citable-unit chunks for this arm. */
    chunker: z.string().min(1),
    embedding: embeddingConfigSchema,
    runtime: runtimeConfigSchema,
    retrieval: retrievalConfigSchema,
    /** The Mongo collection chunks + embeddings live in. */
    collection: z.string().min(1),
    /** The single Atlas vector search index name (M0 ≤ 3 indexes — #14 adds B-arm + BM25). */
    indexName: z.string().min(1),
  })
  .strict()

export type EmbeddingConfig = z.infer<typeof embeddingConfigSchema>
export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>
export type RetrievalConfig = z.infer<typeof retrievalConfigSchema>
export type PipelineConfig = z.infer<typeof pipelineConfigSchema>

/**
 * The pinned naive-rag config for issue #10. The index name carries the
 * embedding model so #14 can add the gemini-embedding B-arm index and a BM25
 * text index under the M0 three-index cap without renaming this one.
 */
export const NAIVE_RAG_PIPELINE_CONFIG: PipelineConfig = {
  arm: 'naive-rag',
  chunker: 'citable-unit',
  embedding: {
    provider: 'voyage',
    model: 'voyage-law-2',
    dimensions: 1024,
  },
  runtime: {
    provider: 'vertex',
    model: 'gemini-2.5-pro',
  },
  retrieval: {
    topK: 8,
  },
  collection: 'chunks',
  indexName: 'vector_voyage_law_2',
}

/** Recursively sorts object keys so the hash is independent of literal order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, val]) => [key, canonicalize(val)]),
    )
  }
  return value
}

/**
 * Content-addresses a pipeline config: lowercase hex SHA-256 over its
 * key-sorted JSON. Any pinned change — chunker, embedding, runtime model,
 * top-k, index — yields a fresh digest, so the build hash moves with the config.
 */
export function pipelineConfigHash(config: PipelineConfig): string {
  const canonical = JSON.stringify(canonicalize(pipelineConfigSchema.parse(config)))
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}
