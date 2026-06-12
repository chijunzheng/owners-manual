/**
 * `naive-rag:serve` — the live HTTP service the Python harness drives. Binds the
 * live providers (Voyage embeddings, Atlas vector search, Vertex Gemini) and the
 * Langfuse tracer around the pure {@link handleAnswerRequest}, builds the run
 * record once from the committed manifest + pinned pipeline config, and serves:
 *
 *   POST /answer   { question, itemId, traceId? }  → AnswerResponse
 *   GET  /healthz                                   → { ok: true }
 *
 * The propagated trace id flows from the request body into the Langfuse trace so
 * the service spans nest under the harness experiment (AC2). Live by design and
 * not unit-tested — every decision it composes is covered upstream against fakes.
 */

import { createServer } from 'node:http'

import { createVoyageEmbeddingProvider } from './embedding.js'
import { NAIVE_RAG_PIPELINE_CONFIG } from './pipeline-config.js'
import { buildRunRecord } from './run-record.js'
import { handleAnswerRequest, parseAnswerRequest } from './service.js'
import { GOLDEN_V0_DOCUMENTS } from './corpus-loader.js'
import { langfuseEnabled, loadRootEnv, repoPath, resolveLiveConfig } from './live/env.js'
import { connectMongoStore } from './live/mongo-store.js'
import { createVertexLlm } from './live/vertex-llm.js'
import { createLangfuseTracer } from './live/langfuse-tracer.js'
import { loadManifestSnapshot } from './live/manifest-snapshot.js'

const PORT = Number(process.env.NAIVE_RAG_PORT ?? 8787)

async function readBody(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  loadRootEnv()
  const live = resolveLiveConfig()
  const config = NAIVE_RAG_PIPELINE_CONFIG

  const provider = createVoyageEmbeddingProvider({
    apiKey: live.voyageApiKey,
    model: config.embedding.model,
    dimensions: config.embedding.dimensions,
  })
  const complete = createVertexLlm({ model: config.runtime.model, location: live.vertexLocation })
  const tracingOn = langfuseEnabled()
  const tracerHandle = tracingOn ? createLangfuseTracer() : undefined
  const store = await connectMongoStore({
    uri: live.mongoUri,
    db: live.mongoDb,
    collection: config.collection,
    indexName: config.indexName,
    dimensions: config.embedding.dimensions,
  })

  const corpusIds = GOLDEN_V0_DOCUMENTS.filter((d) => d.kind === 'corpus').map((d) => d.id)
  const manifestSources = await loadManifestSnapshot(repoPath('corpus', 'manifest.json'), corpusIds)
  const runRecord = buildRunRecord({
    config,
    manifestSources,
    includedDocumentIds: GOLDEN_V0_DOCUMENTS.map((d) => d.id),
  })

  const deps = {
    provider,
    search: store.search,
    complete,
    runRecord,
    topK: config.retrieval.topK,
    tracer: tracerHandle?.tracer,
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === 'GET' && req.url === '/healthz') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, build: runRecord.corpusBuildHash }))
          return
        }
        if (req.method === 'POST' && req.url === '/answer') {
          const request = parseAnswerRequest(JSON.parse(await readBody(req)))
          const response = await handleAnswerRequest(request, deps)
          await tracerHandle?.flush()
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(response))
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: message }))
      }
    })()
  })

  const shutdown = async (): Promise<void> => {
    await tracerHandle?.shutdown().catch(() => {})
    await store.close().catch(() => {})
    server.close()
  }
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)))
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)))

  server.listen(PORT, () => {
    process.stdout.write(`naive-rag service listening on http://127.0.0.1:${PORT}\n`)
    process.stdout.write(`  build ${runRecord.corpusBuildHash}\n`)
    process.stdout.write(`  model ${config.runtime.model} · embed ${config.embedding.model}\n`)
    process.stdout.write(
      `  langfuse tracing: ${tracingOn ? 'on' : 'off (keys unset/placeholder)'}\n`,
    )
  })
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`serve failed: ${message}\n`)
  process.exitCode = 1
})
