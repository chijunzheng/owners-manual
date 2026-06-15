/**
 * The naive-rag arm (issue #10): the first end-to-end eval pipeline — fixed-size
 * chunks, one embedding provider, an Atlas vector index, top-k retrieval, and
 * plain Vertex-Gemini synthesis under the structured answer envelope. The Python
 * harness runs golden v0 through it and scores the first dashboard.
 *
 * This barrel exports the pure, provider-free seams (envelope, config, chunking,
 * retrieval, synthesis, orchestration, index definition, run record). The live
 * provider bindings (Mongo, Vertex, Voyage, Langfuse) live in their own modules
 * and the CLIs, never imported by the unit suite.
 */

export {
  ANSWER_BEHAVIOR_CLASSES,
  answerClaimSchema,
  answerEnvelopeSchema,
  candidateCites,
  parseAnswerEnvelope,
  type AnswerBehaviorClass,
  type AnswerClaim,
  type AnswerEnvelope,
} from './answer-envelope.js'

export {
  NAIVE_RAG_PIPELINE_CONFIG,
  embeddingConfigSchema,
  pipelineConfigHash,
  pipelineConfigSchema,
  retrievalConfigSchema,
  runtimeConfigSchema,
  type EmbeddingConfig,
  type PipelineConfig,
  type RetrievalConfig,
  type RuntimeConfig,
} from './pipeline-config.js'

export {
  createVoyageEmbeddingProvider,
  type EmbeddingProvider,
  type VoyageEmbeddingOptions,
  type VoyageFetch,
} from './embedding.js'

export { chunkParsedDocuments, type CorpusChunk, type ParsedCorpusEntry } from './chunk-corpus.js'

export {
  parsePathKey,
  retrieveTopK,
  type RetrievedCandidate,
  type RetrievalStage,
  type RetrieveOptions,
  type RetrieveResult,
  type VectorSearchExecutor,
  type VectorSearchHit,
} from './retrieve.js'

export {
  bm25Rank,
  tokenize,
  type Bm25Document,
  type Bm25Hit,
  type Bm25RankOptions,
} from './bm25.js'

export {
  RRF_K_DEFAULT,
  fuseByRrf,
  type FusedCandidate,
  type FuseOptions,
  type RankedList,
} from './rrf.js'

export {
  AUTHORITY_LEVELS,
  authorityLevelOf,
  authorityRank,
  isHigherAuthority,
  type AuthorityLevel,
} from './authority.js'

export {
  retrieveHybrid,
  type HybridCandidate,
  type RetrieveHybridOptions,
  type RetrieveHybridResult,
  type TextSearchExecutor,
} from './hybrid-retrieve.js'

export {
  RETRIEVE_DEBUG_MODES,
  handleRetrieveDebugRequest,
  parseRetrieveDebugRequest,
  retrieveDebugRequestSchema,
  type DebugCandidate,
  type RetrieveDebugDeps,
  type RetrieveDebugMode,
  type RetrieveDebugRequest,
  type RetrieveDebugResponse,
} from './retrieve-debug.js'

export {
  buildSynthesisPrompt,
  synthesize,
  type LlmComplete,
  type SynthesizeOptions,
  type SynthesizeResult,
} from './synthesize.js'

export {
  runNaiveRag,
  type NaiveRagTracer,
  type RunNaiveRagOptions,
  type RunNaiveRagResult,
  type TraceHandle,
  type TraceSpan,
} from './naive-rag.js'

export {
  BM25_TEXT_INDEX_NAME,
  buildTextSearchIndexDefinition,
  buildVectorIndexDefinition,
  ensureSearchIndex,
  ensureVectorIndex,
  type EnsureIndexResult,
  type SearchIndexCollection,
  type SearchIndexDefinition,
  type TextSearchIndexDefinition,
  type VectorIndexDefinition,
  type VectorIndexField,
  type VectorIndexSpec,
} from './atlas-index.js'

export {
  buildRunRecord,
  fixtureSnapshotSourceSchema,
  manifestSnapshotSourceSchema,
  runRecordSchema,
  type BuildRunRecordOptions,
  type FixtureSnapshotSource,
  type ManifestSnapshotSource,
  type RunRecord,
} from './run-record.js'

export {
  GOLDEN_V0_DOCUMENTS,
  loadCorpusForIngest,
  loadFixtureSnapshot,
  type CorpusDocumentSource,
  type HtmlReader,
  type LoadCorpusOptions,
} from './corpus-loader.js'

export {
  buildTextSearchPipeline,
  buildVectorSearchPipeline,
  type TextSearchPipelineSpec,
  type TextSearchStage,
  type VectorSearchPipelineSpec,
  type VectorSearchStage,
} from './vector-search-pipeline.js'

export { extractManifestSnapshot } from './manifest-snapshot-util.js'

export {
  RETRIEVAL_CORPUS_SOURCES,
  chunkFixtureToRows,
  renderRetrievalCorpus,
  type RetrievalCorpusRow,
  type RetrievalCorpusSource,
} from './retrieval-corpus.js'

export {
  answerRequestSchema,
  handleAnswerRequest,
  parseAnswerRequest,
  resolveTraceContext,
  type AnswerRequest,
  type AnswerResponse,
  type ServiceDeps,
} from './service.js'

export {
  AGENT_LOOP_CAPS,
  GUARD_VERDICTS,
  guardVerdictToBehavior,
  type AgentModel,
  type AgentRetrieve,
  type AgentRetrieveDeps,
  type AgentState,
  type CriticDecision,
  type GuardDecision,
  type GuardVerdict,
  type RetrievalHop,
  type RetrievalPlan,
} from './agent-types.js'

export {
  AGENT_NODES,
  AGENT_RECURSION_LIMIT,
  buildAgentGraph,
  runAgentGraph,
  type AgentGraphDeps,
  type AgentGraphResult,
  type AgentNodeName,
} from './agent-graph.js'

export {
  AGENT_TOP_K_DEFAULT,
  clampEnvelopeToCandidates,
  clampPlan,
  mergeCandidates,
  rerankByAuthority,
  routeAfterCritic,
  routeAfterGuard,
  type AgentStatePatch,
} from './agent-nodes.js'

export {
  runAgent,
  type AgentTracer,
  type RunAgentOptions,
  type RunAgentResult,
} from './agent-run.js'

export {
  buildAgentSynthesisPrompt,
  buildCriticPrompt,
  buildGuardPrompt,
  buildPlannerPrompt,
} from './agent-prompts.js'

export {
  chatRequestSchema,
  formatSseEvent,
  handleChatRequest,
  parseChatRequest,
  type ChatEvent,
  type ChatEventSink,
  type ChatRequest,
  type ChatServiceDeps,
} from './chat-service.js'

export {
  CORPORA,
  corpusOfDocument,
  corpusOfInputFile,
  documentsForCorpora,
  type CorpusTag,
} from './corpus-tag.js'

export {
  buildStuffedCandidates,
  permuteCanonicalOrder,
  stuffedSourceCount,
  synthesizeStuffed,
  type StuffLlmComplete,
  type StuffUsage,
  type SynthesizeStuffedOptions,
  type SynthesizeStuffedResult,
} from './stuff-synthesis.js'

export {
  runStuff,
  stuffCostUsd,
  type RunStuffOptions,
  type RunStuffResult,
  type StuffArm,
  type StuffCostRates,
  type StuffTracer,
} from './stuff.js'

export {
  handleStuffRequest,
  parseStuffOracleRequest,
  parseStuffRequest,
  stuffOracleRequestSchema,
  stuffRequestSchema,
  type StuffOracleRequestBody,
  type StuffRequest,
  type StuffRequestBody,
  type StuffResponse,
  type StuffServiceDeps,
} from './stuff-service.js'

export {
  STUFF_RUNTIME_CONFIG,
  buildChunksForArm,
  stuffRuntimeConfigSchema,
  type BuildChunksForArmOptions,
  type StuffRuntimeConfig,
} from './stuff-config.js'

export { mapVertexUsage, type VertexUsageMetadata } from './stuff-usage.js'
