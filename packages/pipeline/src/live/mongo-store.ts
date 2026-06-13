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
  ensureVectorIndex,
  type EnsureIndexResult,
  type SearchIndexCollection,
} from '../atlas-index.js'
import { type CorpusChunk } from '../chunk-corpus.js'
import { type VectorSearchExecutor, type VectorSearchHit } from '../retrieve.js'
import { buildVectorSearchPipeline } from '../vector-search-pipeline.js'

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
  /** Replace all chunk rows with the supplied embedded chunks. */
  replaceChunks(rows: readonly ChunkRow[]): Promise<number>
  /** Count stored chunk rows. */
  count(): Promise<number>
  /** A vector-search executor over the stored rows. */
  readonly search: VectorSearchExecutor
  /** Close the underlying connection. */
  close(): Promise<void>
}

/** Connect and return a {@link MongoStore} over the chunk collection. */
export async function connectMongoStore(options: MongoStoreOptions): Promise<MongoStore> {
  const client = new MongoClient(options.uri, { serverSelectionTimeoutMS: 10_000 })
  await client.connect()
  const collection = client.db(options.db).collection<ChunkRow>(options.collection)

  const search: VectorSearchExecutor = async ({ queryVector, topK }) => {
    const pipeline = buildVectorSearchPipeline({
      indexName: options.indexName,
      queryVector: [...queryVector],
      topK,
    })
    const rows = await collection.aggregate(pipeline as object[]).toArray()
    return rows.map(
      (row): VectorSearchHit => ({
        documentId: String(row.documentId),
        citablePathKey: String(row.citablePathKey),
        text: String(row.text),
        score: Number(row.score),
      }),
    )
  }

  return {
    ensureIndex: () =>
      ensureVectorIndex(collection as unknown as SearchIndexCollection, {
        name: options.indexName,
        path: 'embedding',
        dimensions: options.dimensions,
      }),
    async replaceChunks(rows) {
      await collection.deleteMany({})
      if (rows.length > 0) {
        await collection.insertMany(rows.map((row) => ({ ...row })))
      }
      return rows.length
    },
    count: () => collection.countDocuments({}),
    search,
    close: () => client.close(),
  }
}

export type { ChunkRow }
