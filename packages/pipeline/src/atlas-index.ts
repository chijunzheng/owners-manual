/**
 * The Atlas vector search index — created programmatically (issue #10), exactly
 * ONE index here. M0 caps Atlas Search at three indexes (ADR 0002, .env.example),
 * so the name carries the embedding model (`vector_voyage_law_2`); #14 adds the
 * gemini-embedding B-arm index and a BM25 text index under the same cap without
 * touching this one.
 *
 * The index definition is a pure function (testable without a cluster), and
 * {@link ensureVectorIndex} is idempotent against an injected collection seam so
 * the unit suite exercises the create-vs-skip decision offline; the live
 * `MongoClient` binding lives in the ingest CLI. `documentId` is declared
 * filterable so retrieval can pre-filter by corpus (ADR 0002: metadata
 * pre-filtering on corpus in a single query path).
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

/** The slice of a Mongo collection's search-index API this module needs. */
export interface SearchIndexCollection {
  listSearchIndexes(): { toArray(): Promise<readonly { name?: string }[]> }
  createSearchIndex(definition: VectorIndexDefinition): Promise<string>
}

export interface EnsureIndexResult {
  readonly name: string
  /** True when this call created the index; false when it already existed. */
  readonly created: boolean
}

/**
 * Create the vector index if absent; a no-op if an index of the same name
 * already exists. Idempotent so re-running ingest is safe and never trips the
 * M0 index cap by accumulating duplicates.
 */
export async function ensureVectorIndex(
  collection: SearchIndexCollection,
  spec: VectorIndexSpec,
): Promise<EnsureIndexResult> {
  const existing = await collection.listSearchIndexes().toArray()
  if (existing.some((index) => index.name === spec.name)) {
    return { name: spec.name, created: false }
  }
  const definition = buildVectorIndexDefinition(spec)
  const name = await collection.createSearchIndex(definition)
  return { name, created: true }
}
