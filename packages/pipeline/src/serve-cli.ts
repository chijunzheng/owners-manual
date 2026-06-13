/**
 * `naive-rag:serve` — the live HTTP service the Python harness drives. Binds the
 * live providers (Voyage embeddings, Atlas vector + BM25 search, Vertex Gemini)
 * and the Langfuse tracer around the pure handlers, builds the run record once
 * from the committed manifest + pinned pipeline config, and serves:
 *
 *   POST /answer          { question, itemId, traceId? }       → AnswerResponse
 *   POST /retrieve/debug  { question, topK?, authorityLevels? } → RetrieveDebugResponse
 *   GET  /retrieve/debug?q=…&topK=…                             → RetrieveDebugResponse
 *   GET  /healthz                                               → { ok: true }
 *
 * The naive-rag `/answer` path is FROZEN (#14): the new `/retrieve/debug`
 * endpoint (ADR 0003: part of the contract) is additive — it exposes hybrid
 * retrieval's ranked candidates WITH stage-provenance so the harness can compute
 * the pre-synthesis hit-rate and the hybrid-vs-vector comparison without a
 * synthesis call. The propagated trace id flows from the request body into the
 * Langfuse trace so the service spans nest under the harness experiment (AC2).
 * Live by design and not unit-tested — every decision it composes is covered
 * upstream against fakes.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

import { createVoyageEmbeddingProvider } from './embedding.js'
import { NAIVE_RAG_PIPELINE_CONFIG } from './pipeline-config.js'
import { buildRunRecord } from './run-record.js'
import { handleAnswerRequest, parseAnswerRequest, resolveTraceContext } from './service.js'
import {
  handleRetrieveDebugRequest,
  parseRetrieveDebugRequest,
  type RetrieveDebugRequest,
} from './retrieve-debug.js'
import { GOLDEN_V0_DOCUMENTS, loadFixtureSnapshot } from './corpus-loader.js'
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

/**
 * Parse a `GET /retrieve/debug?q=…&topK=…&authority=act,regulation` query into a
 * debug request (the same schema the POST body validates). The question accepts
 * either `q` or `question`; `authority` is a comma-separated level list.
 */
function debugRequestFromQuery(url: URL): RetrieveDebugRequest {
  const params = url.searchParams
  const raw: Record<string, unknown> = {
    question: params.get('q') ?? params.get('question') ?? '',
  }
  const topK = params.get('topK')
  if (topK !== null) raw.topK = Number(topK)
  const mode = params.get('mode')
  if (mode !== null) raw.mode = mode
  const authority = params.get('authority')
  if (authority !== null) raw.authorityLevels = authority.split(',').filter((s) => s.length > 0)
  return parseRetrieveDebugRequest(raw)
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
  const fixtureSources = await loadFixtureSnapshot({
    documents: GOLDEN_V0_DOCUMENTS,
    read: (relPath) => readFile(repoPath(relPath), 'utf8'),
  })
  const runRecord = buildRunRecord({
    config,
    manifestSources,
    fixtureSources,
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

  // The retrieval-debug endpoint reuses the same embedding provider and Atlas
  // collection, adding the BM25 text-search executor for the hybrid path.
  const debugDeps = {
    provider,
    vectorSearch: store.search,
    textSearch: store.textSearch,
    topK: config.retrieval.topK,
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
          const body = parseAnswerRequest(JSON.parse(await readBody(req)))
          // The harness names its parent span via the W3C traceparent header;
          // consuming it is what nests the service spans under the harness span.
          const context = resolveTraceContext(body.traceId, req.headers.traceparent)
          const request = { ...body, traceId: context.traceId, parentSpanId: context.parentSpanId }
          const response = await handleAnswerRequest(request, deps)
          await tracerHandle?.flush()
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(response))
          return
        }
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
        if (req.method === 'POST' && url.pathname === '/retrieve/debug') {
          const request = parseRetrieveDebugRequest(JSON.parse(await readBody(req)))
          const response = await handleRetrieveDebugRequest(request, debugDeps)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(response))
          return
        }
        if (req.method === 'GET' && url.pathname === '/retrieve/debug') {
          const response = await handleRetrieveDebugRequest(debugRequestFromQuery(url), debugDeps)
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
    process.stdout.write(`  endpoints: POST /answer · GET|POST /retrieve/debug · GET /healthz\n`)
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
