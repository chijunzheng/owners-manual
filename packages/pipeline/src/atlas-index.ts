/**
 * The Atlas search indexes — created programmatically (issue #10/#14). M0 caps
 * Atlas Search at three indexes (ADR 0002, .env.example): one `vectorSearch`
 * index per embedding arm (`vector_voyage_law_2`, with the gemini B-arm reserved)
 * plus one `search` (BM25 text) index — exactly the three-index budget. #14 adds
 * the BM25 text index here without renaming the vector one.
 *
 * Every index definition is a pure function (testable without a cluster), and
 * {@link ensureSearchIndex} is idempotent against an injected collection seam so
 * the unit suite exercises the create-vs-skip decision offline; the live
 * `MongoClient` binding lives in the CLIs. `documentId` is declared filterable on
 * BOTH indexes so retrieval can pre-filter by corpus and authority level (ADR
 * 0002: metadata pre-filtering in a single query path).
 */

/** A vectorSearch index field: the vector itself or a filterable scalar. */
export type VectorIndexField =
  | {
      readonly type: 'vector'
      readonly path: string
      readonly numDimensions: number
      readonly similarity: 'cosine' | 'euclidean' | 'dotProduct'
    }
  | { readonly type: 'filter'; readonly path: string }

/** A full Atlas `vectorSearch` index definition. */
export interface VectorIndexDefinition {
  readonly name: string
  readonly type: 'vectorSearch'
  readonly definition: { readonly fields: readonly VectorIndexField[] }
}

export interface VectorIndexSpec {
  /** The index name — carries the embedding model for the M0 three-index cap. */
  readonly name: string
  /** The document field holding the embedding vector. */
  readonly path: string
  /** The embedding dimension (1024 for voyage-law-2). */
  readonly dimensions: number
}

/** Build the single vectorSearch index definition for this arm. */
export function buildVectorIndexDefinition(spec: VectorIndexSpec): VectorIndexDefinition {
  return {
    name: spec.name,
    type: 'vectorSearch',
    definition: {
      fields: [
        { type: 'vector', path: spec.path, numDimensions: spec.dimensions, similarity: 'cosine' },
        { type: 'filter', path: 'documentId' },
      ],
    },
  }
}

/** The name of the single BM25 text index (#14), distinct from any vector index. */
export const BM25_TEXT_INDEX_NAME = 'text_bm25'

/** A full Atlas `search` (BM25/text) index definition. */
export interface TextSearchIndexDefinition {
  readonly name: string
  readonly type: 'search'
  readonly definition: {
    readonly mappings: {
      readonly dynamic: false
      readonly fields: {
        /** The chunk text, analyzed so BM25 can score term overlap. */
        readonly text: { readonly type: 'string' }
        /** documentId as a keyword token so $search can pre-filter by it. */
        readonly documentId: { readonly type: 'token' }
        /** The citable path key as a keyword token (returned, not analyzed). */
        readonly citablePathKey: { readonly type: 'token' }
      }
    }
  }
}

/**
 * Build the single BM25 text-search index definition (#14). It is a `search`
 * index (lexical), not a `vectorSearch` index: `text` is analyzed for Okapi
 * BM25 scoring, and `documentId`/`citablePathKey` are kept as tokens so the
 * `$search` stage can pre-filter by corpus and authority level and project the
 * path key back (ADR 0002, one query path).
 */
export function buildTextSearchIndexDefinition(): TextSearchIndexDefinition {
  return {
    name: BM25_TEXT_INDEX_NAME,
    type: 'search',
    definition: {
      mappings: {
        dynamic: false,
        fields: {
          text: { type: 'string' },
          documentId: { type: 'token' },
          citablePathKey: { type: 'token' },
        },
      },
    },
  }
}

/** Any Atlas search index definition this module can create. */
export type SearchIndexDefinition = VectorIndexDefinition | TextSearchIndexDefinition

/** The slice of a Mongo collection's search-index API this module needs. */
export interface SearchIndexCollection {
  listSearchIndexes(): { toArray(): Promise<readonly { name?: string }[]> }
  createSearchIndex(definition: SearchIndexDefinition): Promise<string>
}

export interface EnsureIndexResult {
  readonly name: string
  /** True when this call created the index; false when it already existed. */
  readonly created: boolean
}

/**
 * Create a search index (vector or text) if absent; a no-op if an index of the
 * same name already exists. Idempotent so re-running ingest is safe and never
 * trips the M0 index cap by accumulating duplicates.
 */
export async function ensureSearchIndex(
  collection: SearchIndexCollection,
  definition: SearchIndexDefinition,
): Promise<EnsureIndexResult> {
  const existing = await collection.listSearchIndexes().toArray()
  if (existing.some((index) => index.name === definition.name)) {
    return { name: definition.name, created: false }
  }
  const name = await collection.createSearchIndex(definition)
  return { name, created: true }
}

/**
 * Create the vector index if absent; idempotent. Thin wrapper over
 * {@link ensureSearchIndex} kept for the naive-rag ingest call site.
 */
export async function ensureVectorIndex(
  collection: SearchIndexCollection,
  spec: VectorIndexSpec,
): Promise<EnsureIndexResult> {
  return ensureSearchIndex(collection, buildVectorIndexDefinition(spec))
}
