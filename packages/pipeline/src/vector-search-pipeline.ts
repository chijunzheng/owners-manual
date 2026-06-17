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

/** The field both indexes declare filterable for corpus/authority pre-filtering. */
const DOCUMENT_ID_PATH = 'documentId'

export interface VectorSearchPipelineSpec {
  readonly indexName: string
  readonly queryVector: readonly number[]
  readonly topK: number
  /**
   * The document-id allow-list to PRE-filter the ANN by (#41 / ADR 0002: metadata
   * pre-filtering on corpus AND authority level in one query path). When present
   * and non-empty, the vector index restricts candidates to these ids INSIDE the
   * `$vectorSearch` stage — never a `$match` after it. An empty list is a no-op
   * (the absence of a filter), never a `$in: []` that would drop every candidate.
   */
  readonly documentIds?: readonly string[]
}

/** A `$vectorSearch.filter` over the filterable `documentId` field. */
export interface VectorSearchFilter {
  readonly documentId: { readonly $in: readonly string[] }
}

/** One pipeline stage shape (loosely typed — Mongo accepts a Document[]). */
export interface VectorSearchStage {
  readonly $vectorSearch?: {
    readonly index: string
    readonly path: string
    readonly queryVector: readonly number[]
    readonly numCandidates: number
    readonly limit: number
    /** Present only when a non-empty document allow-list pre-filters the ANN. */
    readonly filter?: VectorSearchFilter
  }
  readonly $project?: Record<string, unknown>
}

export interface TextSearchPipelineSpec {
  readonly indexName: string
  readonly query: string
  readonly topK: number
  /** The document-id allow-list to PRE-filter the BM25 query by (#41); see above. */
  readonly documentIds?: readonly string[]
}

/** A BM25 `$search` text operator (the scoring clause). */
export interface TextSearchTextOperator {
  readonly query: string
  readonly path: string
}

/** A `$search` `compound.filter` `in` clause over the `documentId` token. */
export interface TextSearchInFilter {
  readonly in: { readonly path: string; readonly value: readonly string[] }
}

/** A `$search` `compound`: the BM25 query scores (`must`), the allow-list filters. */
export interface TextSearchCompound {
  readonly must: readonly [{ readonly text: TextSearchTextOperator }]
  readonly filter: readonly TextSearchInFilter[]
}

/** One BM25 `$search` pipeline stage shape (loosely typed for Mongo). */
export interface TextSearchStage {
  readonly $search?: {
    readonly index: string
    /** The bare BM25 query — present only when no document pre-filter applies. */
    readonly text?: TextSearchTextOperator
    /** The query wrapped with a `documentId` pre-filter — present when filtered. */
    readonly compound?: TextSearchCompound
  }
  readonly $limit?: number
  readonly $project?: Record<string, unknown>
}

/** A non-empty document allow-list, or undefined when there is nothing to filter on. */
function documentFilter(documentIds: readonly string[] | undefined): readonly string[] | undefined {
  return documentIds && documentIds.length > 0 ? documentIds : undefined
}

/** Build the `$vectorSearch` → `$project` pipeline for a top-k query. */
export function buildVectorSearchPipeline(
  spec: VectorSearchPipelineSpec,
): readonly VectorSearchStage[] {
  const allow = documentFilter(spec.documentIds)
  return [
    {
      $vectorSearch: {
        index: spec.indexName,
        path: EMBEDDING_PATH,
        queryVector: spec.queryVector,
        numCandidates: Math.max(spec.topK * NUM_CANDIDATES_FACTOR, spec.topK),
        limit: spec.topK,
        // A new object spread keeps the stage immutable: the filter key only
        // exists when an allow-list is supplied.
        ...(allow ? { filter: { documentId: { $in: allow } } } : {}),
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
 *
 * When a document allow-list is supplied (#41 / ADR 0002), the BM25 query moves
 * into a `compound.must` and the allow-list becomes a `compound.filter` `in`
 * clause over the indexed `documentId` token — a true pre-filter that bounds the
 * lexical candidate set before the top-k cut, so a higher-authority match is
 * never crowded out of the over-fetch window by disallowed documents.
 */
export function buildTextSearchPipeline(spec: TextSearchPipelineSpec): readonly TextSearchStage[] {
  const allow = documentFilter(spec.documentIds)
  const text: TextSearchTextOperator = { query: spec.query, path: TEXT_PATH }
  return [
    {
      $search: {
        index: spec.indexName,
        ...(allow
          ? {
              compound: {
                must: [{ text }],
                filter: [{ in: { path: DOCUMENT_ID_PATH, value: allow } }],
              },
            }
          : { text }),
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
