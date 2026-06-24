/**
 * The live Mongo binding (ADR 0002 — Atlas Vector Search). Connects to the
 * `owners_manual` database, owns the chunk collection, ensures the single vector
 * index, stores embedded chunk rows, and exposes a {@link VectorSearchExecutor}
 * backed by the `$vectorSearch` aggregation.
 *
 * Thin glue over the verified `mongodb` driver — exercised by the ingest/serve
 * CLIs, not the unit suite (the index definition, idempotency, and aggregation
 * shape are unit-tested in atlas-index / vector-search-pipeline against fakes).
 */

import { MongoClient } from 'mongodb'

import {
  buildTextSearchIndexDefinition,
  ensureSearchIndex,
  ensureVectorIndex,
  type EnsureIndexResult,
  type SearchIndexCollection,
} from '../atlas-index.js'
import { type CorpusChunk } from '../chunk-corpus.js'
import { type TextSearchExecutor } from '../hybrid-retrieve.js'
import { type VectorSearchExecutor, type VectorSearchHit } from '../retrieve.js'
import { buildTextSearchPipeline, buildVectorSearchPipeline } from '../vector-search-pipeline.js'

/** A stored chunk row: the corpus chunk plus its embedding vector. */
interface ChunkRow extends CorpusChunk {
  readonly embedding: number[]
}

export interface MongoStoreOptions {
  readonly uri: string
  readonly db: string
  readonly collection: string
  readonly indexName: string
  readonly dimensions: number
}

export interface MongoStore {
  /** Create the vector index if absent (idempotent). */
  ensureIndex(): Promise<EnsureIndexResult>
  /** Create the BM25 text index if absent (idempotent) — #14 hybrid stage. */
  ensureTextIndex(): Promise<EnsureIndexResult>
  /** Replace all chunk rows with the supplied embedded chunks. */
  replaceChunks(rows: readonly ChunkRow[]): Promise<number>
  /**
   * Read every stored chunk row (#16). The agent's one-hop graph expansion
   * resolves a cross-reference edge's far endpoint to a candidate through these
   * rows (projected by `buildEnrichmentLookup`); serve loads them ONCE at start,
   * not per query. Live by design — the projection + lookup map are unit-tested
   * offline against in-memory rows.
   */
  listChunks(): Promise<readonly ChunkRow[]>
  /** Count stored chunk rows. */
  count(): Promise<number>
  /** A vector-search executor over the stored rows. */
  readonly search: VectorSearchExecutor
  /** A BM25 text-search executor over the stored rows (#14 hybrid stage). */
  readonly textSearch: TextSearchExecutor
  /** Close the underlying connection. */
  close(): Promise<void>
}

/** Connect and return a {@link MongoStore} over the chunk collection. */
export async function connectMongoStore(options: MongoStoreOptions): Promise<MongoStore> {
  const client = new MongoClient(options.uri, { serverSelectionTimeoutMS: 10_000 })
  await client.connect()
  const collection = client.db(options.db).collection<ChunkRow>(options.collection)

  const toHit = (row: Record<string, unknown>): VectorSearchHit => ({
    documentId: String(row.documentId),
    citablePathKey: String(row.citablePathKey),
    text: String(row.text),
    score: Number(row.score),
  })

  const search: VectorSearchExecutor = async ({ queryVector, topK, documentIds }) => {
    const pipeline = buildVectorSearchPipeline({
      indexName: options.indexName,
      queryVector: [...queryVector],
      topK,
      // The #41 true pre-filter: when present, the builder emits
      // `$vectorSearch.filter` over the filterable `documentId` field.
      documentIds,
    })
    const rows = await collection.aggregate(pipeline as object[]).toArray()
    return rows.map(toHit)
  }

  const textSearch: TextSearchExecutor = async ({ query, topK, documentIds }) => {
    const pipeline = buildTextSearchPipeline({
      indexName: buildTextSearchIndexDefinition().name,
      query,
      topK,
      // The #41 true pre-filter: when present, the builder wraps the query in a
      // `$search` compound with a `documentId` token filter.
      documentIds,
    })
    const rows = await collection.aggregate(pipeline as object[]).toArray()
    return rows.map(toHit)
  }

  return {
    ensureIndex: () =>
      ensureVectorIndex(collection as unknown as SearchIndexCollection, {
        name: options.indexName,
        path: 'embedding',
        dimensions: options.dimensions,
      }),
    ensureTextIndex: () =>
      ensureSearchIndex(
        collection as unknown as SearchIndexCollection,
        buildTextSearchIndexDefinition(),
      ),
    async replaceChunks(rows) {
      await collection.deleteMany({})
      if (rows.length > 0) {
        await collection.insertMany(rows.map((row) => ({ ...row })))
      }
      return rows.length
    },
    async listChunks() {
      // Drop only Mongo's `_id`; the stored fields ARE the ChunkRow shape (#16).
      const rows = await collection.find({}, { projection: { _id: 0 } }).toArray()
      return rows.map((row) => ({
        id: String(row.id),
        citablePathKey: String(row.citablePathKey),
        text: String(row.text),
        documentId: String(row.documentId),
        chunker: String(row.chunker),
        embedding: Array.isArray(row.embedding) ? (row.embedding as number[]) : [],
      }))
    },
    count: () => collection.countDocuments({}),
    search,
    textSearch,
    close: () => client.close(),
  }
}

export type { ChunkRow }
