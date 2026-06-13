/**
 * The Atlas search aggregation pipelines — pure builders, so each stage shape
 * (index, path, over-fetch, score projection) is unit-tested without a cluster.
 * The Mongo store runs whatever these return. #14 adds the BM25 `$search` text
 * pipeline beside the `$vectorSearch` one; both project the same stored chunk
 * fields so hybrid retrieval can fuse them by RRF on the path key.
 */

/** The embedding field the vector index is built over (see atlas-index). */
const EMBEDDING_PATH = 'embedding'

/** The analyzed text field the BM25 text index is built over (see atlas-index). */
const TEXT_PATH = 'text'

/** ANN over-fetch factor: candidates considered before the top-k cut. */
const NUM_CANDIDATES_FACTOR = 10

export interface VectorSearchPipelineSpec {
  readonly indexName: string
  readonly queryVector: readonly number[]
  readonly topK: number
}

/** One pipeline stage shape (loosely typed — Mongo accepts a Document[]). */
export interface VectorSearchStage {
  readonly $vectorSearch?: {
    readonly index: string
    readonly path: string
    readonly queryVector: readonly number[]
    readonly numCandidates: number
    readonly limit: number
  }
  readonly $project?: Record<string, unknown>
}

export interface TextSearchPipelineSpec {
  readonly indexName: string
  readonly query: string
  readonly topK: number
}

/** One BM25 `$search` pipeline stage shape (loosely typed for Mongo). */
export interface TextSearchStage {
  readonly $search?: {
    readonly index: string
    readonly text: { readonly query: string; readonly path: string }
  }
  readonly $limit?: number
  readonly $project?: Record<string, unknown>
}

/** Build the `$vectorSearch` → `$project` pipeline for a top-k query. */
export function buildVectorSearchPipeline(
  spec: VectorSearchPipelineSpec,
): readonly VectorSearchStage[] {
  return [
    {
      $vectorSearch: {
        index: spec.indexName,
        path: EMBEDDING_PATH,
        queryVector: spec.queryVector,
        numCandidates: Math.max(spec.topK * NUM_CANDIDATES_FACTOR, spec.topK),
        limit: spec.topK,
      },
    },
    {
      $project: {
        _id: 0,
        documentId: 1,
        citablePathKey: 1,
        text: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ]
}

/**
 * Build the BM25 `$search` → `$limit` → `$project` pipeline for a top-k lexical
 * query (#14). `$search` must lead an Atlas aggregation, so the top-k cut is a
 * separate `$limit` stage; the projection mirrors the vector pipeline (same
 * stored fields) plus the BM25 `searchScore`, so the two rankings fuse on the
 * path key.
 */
export function buildTextSearchPipeline(spec: TextSearchPipelineSpec): readonly TextSearchStage[] {
  return [
    {
      $search: {
        index: spec.indexName,
        text: { query: spec.query, path: TEXT_PATH },
      },
    },
    { $limit: spec.topK },
    {
      $project: {
        _id: 0,
        documentId: 1,
        citablePathKey: 1,
        text: 1,
        score: { $meta: 'searchScore' },
      },
    },
  ]
}
