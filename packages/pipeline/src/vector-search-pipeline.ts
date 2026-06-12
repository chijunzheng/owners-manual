/**
 * The Atlas `$vectorSearch` aggregation pipeline — a pure builder, so the stage
 * shape (index, path, numCandidates over-fetch, score projection) is unit-tested
 * without a cluster. The Mongo store runs whatever this returns.
 */

/** The embedding field the vector index is built over (see atlas-index). */
const EMBEDDING_PATH = 'embedding'

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
