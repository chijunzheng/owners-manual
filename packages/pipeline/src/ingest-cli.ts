/**
 * `naive-rag:ingest` — the one-time corpus build for the naive-rag arm. Parses
 * the golden-v0 (tenancy-only) documents, chunks them with the pinned
 * `citable-unit` chunker, embeds every chunk with voyage-law-2, ensures the
 * single Atlas vector index, and replaces the stored chunk rows. Prints the
 * corpus-build hash so the run record and dashboard can pin to it.
 *
 * Live by design (sanctioned, cheap): reads the gitignored corpus/raw bytes,
 * calls Voyage, and writes to Atlas. Not exercised by vitest — every decision it
 * composes is unit-tested against fakes upstream.
 */

import { readFile } from 'node:fs/promises'

import { citableUnitChunker } from '@owners-manual/enrichment'

import { chunkParsedDocuments } from './chunk-corpus.js'
import { GOLDEN_V0_DOCUMENTS, loadCorpusForIngest, loadFixtureSnapshot } from './corpus-loader.js'
import { createVoyageEmbeddingProvider } from './embedding.js'
import { NAIVE_RAG_PIPELINE_CONFIG } from './pipeline-config.js'
import { buildRunRecord, type ManifestSnapshotSource } from './run-record.js'
import { loadRootEnv, repoPath, resolveLiveConfig } from './live/env.js'
import { connectMongoStore, type ChunkRow } from './live/mongo-store.js'
import { loadManifestSnapshot } from './live/manifest-snapshot.js'

const BATCH = 96

/**
 * Spacing between embed requests. Voyage's free tier (no payment method) is
 * 3 RPM; ~21s between requests keeps the one-time ingest under that proactively,
 * with the provider's 429 backoff covering any burst. Override with
 * VOYAGE_INGEST_SPACING_MS=0 once a payment method lifts the cap.
 */
const SPACING_MS = Number(process.env.VOYAGE_INGEST_SPACING_MS ?? 21_000)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<number> {
  loadRootEnv()
  const live = resolveLiveConfig()
  const config = NAIVE_RAG_PIPELINE_CONFIG

  process.stdout.write('Parsing golden-v0 corpus (tenancy-only)…\n')
  const corpus = await loadCorpusForIngest({
    documents: GOLDEN_V0_DOCUMENTS,
    read: (relPath) => readFile(repoPath(relPath), 'utf8'),
  })
  const chunks = chunkParsedDocuments(corpus, citableUnitChunker)
  process.stdout.write(
    `Chunked ${chunks.length} citable units across ${corpus.length} documents.\n`,
  )

  const provider = createVoyageEmbeddingProvider({
    apiKey: live.voyageApiKey,
    model: config.embedding.model,
    dimensions: config.embedding.dimensions,
  })

  process.stdout.write(
    `Embedding with ${config.embedding.model} (${config.embedding.dimensions}-dim)…\n`,
  )
  const rows: ChunkRow[] = []
  for (let i = 0; i < chunks.length; i += BATCH) {
    if (i > 0 && SPACING_MS > 0) await sleep(SPACING_MS)
    const batch = chunks.slice(i, i + BATCH)
    const vectors = await provider.embedDocuments(batch.map((c) => c.text))
    batch.forEach((chunk, j) => rows.push({ ...chunk, embedding: vectors[j]! }))
    process.stdout.write(`  embedded ${Math.min(i + BATCH, chunks.length)}/${chunks.length}\n`)
  }

  const store = await connectMongoStore({
    uri: live.mongoUri,
    db: live.mongoDb,
    collection: config.collection,
    indexName: config.indexName,
    dimensions: config.embedding.dimensions,
  })
  try {
    const stored = await store.replaceChunks(rows)
    process.stdout.write(`Stored ${stored} chunk rows in ${live.mongoDb}.${config.collection}.\n`)
    const index = await store.ensureIndex()
    process.stdout.write(
      index.created
        ? `Created vector index "${index.name}" (build may take ~1 min to be queryable).\n`
        : `Vector index "${index.name}" already exists.\n`,
    )
    // #14: the BM25 text index over the SAME chunk collection powers the hybrid
    // retrieval-debug path. Creating it here is additive — it never alters the
    // naive-rag arm's vector-only retrieval or its corpus-build hash.
    const textIndex = await store.ensureTextIndex()
    process.stdout.write(
      textIndex.created
        ? `Created BM25 text index "${textIndex.name}" (build may take ~1 min to be queryable).\n`
        : `BM25 text index "${textIndex.name}" already exists.\n`,
    )
  } finally {
    await store.close()
  }

  const manifestSources: ManifestSnapshotSource[] = await loadManifestSnapshot(
    repoPath('corpus', 'manifest.json'),
    corpus
      .filter((c) => c.documentId.startsWith('rta-') || c.documentId.startsWith('reg-'))
      .map((c) => c.documentId),
  )
  const fixtureSources = await loadFixtureSnapshot({
    documents: GOLDEN_V0_DOCUMENTS,
    read: (relPath) => readFile(repoPath(relPath), 'utf8'),
  })
  const record = buildRunRecord({
    config,
    manifestSources,
    fixtureSources,
    includedDocumentIds: corpus.map((c) => c.documentId),
  })
  process.stdout.write(`\nCorpus build hash: ${record.corpusBuildHash}\n`)
  process.stdout.write(`Pipeline config hash: ${record.pipelineConfigHash}\n`)
  return 0
}

process.exitCode = await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`ingest failed: ${message}\n`)
  return 1
})
