/**
 * `naive-rag:serve` — the live HTTP service the Python harness drives. Binds the
 * live providers (Voyage embeddings, Atlas vector + BM25 search, Vertex Gemini)
 * and the Langfuse tracer around the pure handlers, builds the run record once
 * from the committed manifest + pinned pipeline config, and serves:
 *
 *   POST /answer          { question, itemId, traceId? }       → AnswerResponse
 *   POST /chat            { question, itemId, traceId?, ownerId?, sessionId? } → SSE token/result stream
 *   POST /stuff           { question, itemId, traceId?, orderSeed? } → StuffResponse
 *   POST /stuff-oracle    { …, corpora: [...] }                → StuffResponse
 *   POST /retrieve/debug  { question, topK?, authorityLevels? } → RetrieveDebugResponse
 *   GET  /retrieve/debug?q=…&topK=…                             → RetrieveDebugResponse
 *   GET  /healthz                                               → { ok: true }
 *
 * The naive-rag `/answer` path is FROZEN (#14): the `/retrieve/debug` endpoint
 * (ADR 0003), the `/chat` SSE endpoint (#15), and the `/stuff` + `/stuff-oracle`
 * stuffing arms (#18) are additive SIBLINGS — `/chat` runs the bounded
 * Guard→Critic agent (`ChatVertexAI`, ADR 0005) and STREAMS tokens while the same
 * run yields the structured envelope the harness scores; `/stuff` and
 * `/stuff-oracle` run the SAME product model over the whole corpus (or the
 * oracle-routed subset) with Vertex context caching, emitting the same envelope
 * plus honest cost-per-question. The propagated trace id flows
 * from the request body into the Langfuse trace so the service spans nest under
 * the harness experiment (AC2). Live by design and not unit-tested — every
 * decision it composes is covered upstream against fakes.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

import { hierarchyChunker } from '@owners-manual/enrichment'

import { createVoyageEmbeddingProvider } from './embedding.js'
import { NAIVE_RAG_PIPELINE_CONFIG } from './pipeline-config.js'
import { buildRunRecord } from './run-record.js'
import { handleAnswerRequest, parseAnswerRequest, resolveTraceContext } from './service.js'
import {
  formatSseEvent,
  handleChatRequest,
  parseChatRequest,
  type ChatServiceDeps,
} from './chat-service.js'
import {
  handleRetrieveDebugRequest,
  parseRetrieveDebugRequest,
  type RetrieveDebugRequest,
} from './retrieve-debug.js'
import { GOLDEN_V0_DOCUMENTS, loadCorpusForIngest, loadFixtureSnapshot } from './corpus-loader.js'
import { chunkParsedDocuments, type CorpusChunk } from './chunk-corpus.js'
import { corpusOfDocument } from './corpus-tag.js'
import { STUFF_RUNTIME_CONFIG, buildChunksForArm } from './stuff-config.js'
import {
  handleStuffRequest,
  parseStuffOracleRequest,
  parseStuffRequest,
  type StuffServiceDeps,
} from './stuff-service.js'
import {
  langfuseEnabled,
  loadRootEnv,
  repoPath,
  resolveCohereApiKey,
  resolveLiveConfig,
} from './live/env.js'
import { connectMongoStore } from './live/mongo-store.js'
import { connectProfileSessionStore } from './live/profile-session-store.js'
import { createVertexLlm } from './live/vertex-llm.js'
import { createVertexStuffLlm } from './live/vertex-stuff-llm.js'
import { createVertexAgentModel } from './live/vertex-agent.js'
import { createVertexSummarizer } from './live/vertex-summarizer.js'
import { createAgentRetrieve } from './live/agent-retrieve.js'
import { createCohereRerank } from './live/cohere-rerank.js'
import { createLlmRerank } from './live/llm-rerank.js'
import { createLangfuseTracer } from './live/langfuse-tracer.js'
import { loadManifestSnapshot } from './live/manifest-snapshot.js'
import { resolveAgentQueryFlags } from './agent-query-flags.js'
import { selectReranker } from './rerank-select.js'

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
  // The two #17 memory mechanisms persist in the SAME database as the chunk
  // collection (ADR 0002): the owner profile (cross-session facts) and the
  // bounded session summary, in their own collections, behind the mockable store
  // contracts the chat handler reads through.
  const memoryStore = await connectProfileSessionStore({
    uri: live.mongoUri,
    db: live.mongoDb,
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
  // collection, adding the BM25 text-search executor for the hybrid path. The
  // corpus's known document-id set is wired from the SAME registry the run record
  // and ingest use (GOLDEN_V0_DOCUMENTS) so the handler can invert authority levels
  // to a documentId allow-list and push it into the stages as a true pre-filter
  // (#41 / ADR 0002) — resolved at the call site, never hardcoded in authority.ts.
  const debugDeps = {
    provider,
    vectorSearch: store.search,
    textSearch: store.textSearch,
    topK: config.retrieval.topK,
    corpusDocumentIds: GOLDEN_V0_DOCUMENTS.map((d) => d.id),
  }

  // The agent (#15) binds Gemini-on-Vertex behind the four node seams and closes
  // #14's frozen hybrid retrieval over the same provider + Atlas executors. Its
  // Langfuse traces carry the agent arm tags so they filter apart from naive-rag.
  const agentTracerHandle = tracingOn
    ? createLangfuseTracer(process.env, undefined, ['agent', 'arm:agent'])
    : undefined

  // The #16 query-time ablation flags + rerank A/B. Flags are resolved from env so
  // a flip is a restart against the SAME corpus build — never a re-index. The
  // rerank provider is selected from the flag: `authority` (deterministic),
  // `cohere` (Rerank 3.5; only when a key resolves — else degrades to authority),
  // or `llm` (the runtime Gemini). The selector is consulted only when the
  // `rerank` flag is on; off-state is the raw RRF order in the rerank node.
  const agentFlags = resolveAgentQueryFlags()
  const cohereApiKey = resolveCohereApiKey()
  const agentRerank = selectReranker(agentFlags.rerankProvider, {
    cohere: cohereApiKey ? createCohereRerank({ apiKey: cohereApiKey }) : undefined,
    llm: createLlmRerank({ model: config.runtime.model, location: live.vertexLocation }),
  })

  // INTERIM (#16 / live-run milestone): the agent's query-time graph expansion and
  // definitions attachment consume #13's tree-level sidecars, but loading the
  // PERSISTED sidecars + an Atlas-backed expansion-target lookup is deferred to the
  // live-run milestone (alongside live hybrid-arm ingestion and the `/stuff`
  // context-cache lifecycle). Until then `enrichment` is left undefined, so the
  // `xrefExpansion` / `definitionsInPrompt` flags fall back to their documented
  // off-state (no expansion, no definitions) even if toggled on — the mechanism is
  // unit-tested against `createAgentEnrichmentAccess`; only the live load is pending.
  const chatDeps: ChatServiceDeps = {
    model: createVertexAgentModel({ model: config.runtime.model, location: live.vertexLocation }),
    retrieve: createAgentRetrieve({
      provider,
      vectorSearch: store.search,
      textSearch: store.textSearch,
      // Same corpus registry as the debug endpoint, so a planner hop's authority
      // levels become a true pre-filter pushed into the stages (#41 / ADR 0002).
      corpusDocumentIds: GOLDEN_V0_DOCUMENTS.map((d) => d.id),
    }),
    rerank: agentRerank,
    flags: agentFlags,
    // The #17 stores + summarizer: the chat handler loads the owner profile and
    // the prior session summary, injects both (distinct mechanisms) into the run,
    // and folds each substantive turn back into the bounded summary.
    profileStore: memoryStore.profiles,
    sessionStore: memoryStore.sessions,
    summarize: createVertexSummarizer({
      model: config.runtime.model,
      location: live.vertexLocation,
    }),
    runRecord,
    topK: config.retrieval.topK,
    tracer: agentTracerHandle?.tracer,
  }

  // The stuffing arms (#18) reuse the SAME product model (ADR 0005) with Vertex
  // context caching, and stuff the committed corpus chunked by the SAME
  // hierarchy chunker the index build uses. The chunks are built once here from
  // the parsed corpus and grouped by document so `stuff` (entire corpus) and
  // `stuff-oracle` (corpus-tag routed) share one canonical document order. The
  // arms emit the additive `/stuff` + `/stuff-oracle` routes — the frozen
  // `/answer` and `/chat` paths above are untouched.
  const parsedCorpus = await loadCorpusForIngest({
    documents: GOLDEN_V0_DOCUMENTS,
    read: (relPath) => readFile(repoPath(relPath), 'utf8'),
  })
  const chunksByDocument = new Map<string, readonly CorpusChunk[]>(
    parsedCorpus.map((entry) => [
      entry.documentId,
      chunkParsedDocuments([entry], hierarchyChunker),
    ]),
  )
  const corpusByDocumentId = new Map(
    GOLDEN_V0_DOCUMENTS.map((doc) => [doc.id, corpusOfDocument(doc)] as const),
  )
  const stuffTracerHandle = tracingOn
    ? createLangfuseTracer(process.env, undefined, ['stuff', 'arm:stuff'])
    : undefined
  const stuffDeps: StuffServiceDeps = {
    // INTERIM (#18 follow-up): no `cachedContentName` is provisioned yet, so live
    // `/stuff` and `/stuff-oracle` currently run UNCACHED. The per-question cost
    // stays honest — it is computed from the real `usage_metadata` and reflects no
    // cache hit — but the promised context-cached baseline is not engaged. Creating
    // the Vertex `CachedContent` over the canonical corpus prefix (keyed to the
    // corpus build hash, with refresh/TTL) is a live-only lifecycle deferred to the
    // live-run milestone (alongside live hybrid-arm ingestion); the adapter already
    // accepts `cachedContentName` for when it lands. Tracked as a follow-up.
    complete: createVertexStuffLlm({
      model: STUFF_RUNTIME_CONFIG.model,
      location: live.vertexLocation,
    }),
    runRecord,
    chunksForArm: buildChunksForArm({
      documentIds: GOLDEN_V0_DOCUMENTS.map((doc) => doc.id),
      chunksByDocument,
      corpusOfDocument: (id) => corpusByDocumentId.get(id) ?? '',
    }),
    costRates: STUFF_RUNTIME_CONFIG.costRates,
    tracer: stuffTracerHandle?.tracer,
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
        if (req.method === 'POST' && req.url === '/chat') {
          const body = parseChatRequest(JSON.parse(await readBody(req)))
          const context = resolveTraceContext(body.traceId, req.headers.traceparent)
          const request = { ...body, traceId: context.traceId, parentSpanId: context.parentSpanId }
          // Open the SSE stream up front; every agent event is written as a frame
          // and flushed so the client sees tokens as synthesis streams (AC1).
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          await handleChatRequest(request, chatDeps, (event) => {
            res.write(formatSseEvent(event))
          })
          await agentTracerHandle?.flush()
          res.end()
          return
        }
        if (req.method === 'POST' && req.url === '/stuff') {
          const body = parseStuffRequest(JSON.parse(await readBody(req)))
          const context = resolveTraceContext(body.traceId, req.headers.traceparent)
          const response = await handleStuffRequest(
            { ...body, arm: 'stuff', traceId: context.traceId, parentSpanId: context.parentSpanId },
            stuffDeps,
          )
          await stuffTracerHandle?.flush()
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(response))
          return
        }
        if (req.method === 'POST' && req.url === '/stuff-oracle') {
          const body = parseStuffOracleRequest(JSON.parse(await readBody(req)))
          const context = resolveTraceContext(body.traceId, req.headers.traceparent)
          const response = await handleStuffRequest(
            {
              ...body,
              arm: 'stuff-oracle',
              traceId: context.traceId,
              parentSpanId: context.parentSpanId,
            },
            stuffDeps,
          )
          await stuffTracerHandle?.flush()
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
    await agentTracerHandle?.shutdown().catch(() => {})
    await stuffTracerHandle?.shutdown().catch(() => {})
    await store.close().catch(() => {})
    await memoryStore.close().catch(() => {})
    server.close()
  }
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)))
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)))

  server.listen(PORT, () => {
    process.stdout.write(`naive-rag service listening on http://127.0.0.1:${PORT}\n`)
    process.stdout.write(`  build ${runRecord.corpusBuildHash}\n`)
    process.stdout.write(`  model ${config.runtime.model} · embed ${config.embedding.model}\n`)
    process.stdout.write(
      `  endpoints: POST /answer · POST /chat (SSE) · POST /stuff · POST /stuff-oracle · GET|POST /retrieve/debug · GET /healthz\n`,
    )
    process.stdout.write(
      `  stuff arms: model ${STUFF_RUNTIME_CONFIG.model} · context caching ${STUFF_RUNTIME_CONFIG.contextCaching ? 'on' : 'off'}\n`,
    )
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
