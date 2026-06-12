/**
 * The LLM offline enrichment track (issue #13) — package barrel.
 *
 * The deterministic ingestion parsers (#7/#8/#31/#12) emit a content-addressed
 * document tree with a path-keyed text sidecar; this package adds the LLM flesh
 * downstream of those bytes WITHOUT ever re-authoring them (ADR 0004/0005). It
 * does so behind injected seams (the Claude client, the PDF reader, the chunker,
 * the per-stage caches) so the whole track runs offline against deterministic
 * fakes in CI and against the real Agent SDK adapter only where credit exists.
 *
 * The pieces, bottom up:
 *   - {@link fakeClaudeClient}/{@link fakePdfReader} — the injected, call-recording
 *     model seams (no provider keys in this checkout);
 *   - {@link hashTree}/{@link hashChunk}/{@link createMemoryCache} — the content
 *     addresses and the per-stage caches keyed to them;
 *   - {@link computeBuildMetadata} — the build identity, `hash(manifest + config)`;
 *   - {@link enrichTree}/{@link enrichChunks} — the per-document tree- and
 *     chunk-level enrichment passes;
 *   - {@link embeddableText}/{@link selectQueryTimeArtifacts} — the consumer seams
 *     where ablation flags flip, never the producers;
 *   - {@link runEnrichmentBuild} — the entry point that wires them into one
 *     content-addressed {@link EnrichmentBuild}.
 *
 * A pure re-export surface: every public type and function of the nine modules
 * plus the build entry point, and nothing defined here.
 */

export const PACKAGE_NAME = '@owners-manual/enrichment'

// --- the injected Claude seam ------------------------------------------------
export {
  type ClaudeRequest,
  type ClaudeResponse,
  type ClaudeClient,
  type RecordedCall,
  type FakeResponder,
  type FakeClaudeOptions,
  type FakeClaudeClient,
  fakeClaudeClient,
} from './claude-client.js'

// --- chunking contract + reference chunker -----------------------------------
export { type Chunk, type Chunker, citableUnitChunker, hashChunk } from './chunk.js'

// --- tree content-address ----------------------------------------------------
export { hashTree } from './tree-hash.js'

// --- per-stage caches --------------------------------------------------------
export {
  type CacheStats,
  type EnrichmentCache,
  type CacheSnapshot,
  type MemoryCacheOptions,
  createMemoryCache,
} from './cache.js'

// --- build identity (content addressing) -------------------------------------
export {
  type PipelineConfig,
  pipelineConfigSchema,
  parsePipelineConfig,
  canonicalJson,
  hashPipelineConfig,
  type BuildMetadata,
  computeBuildMetadata,
} from './pipeline-config.js'

// --- the injected PDF-read seam + coverage diff ------------------------------
export {
  type PdfReadRequest,
  type PdfReader,
  type FakePdfResponder,
  type FakePdfReaderOptions,
  type FakePdfReader,
  fakePdfReader,
  validatePdfRead,
  type PdfCoverageResult,
  checkPdfCoverage,
} from './pdf-track.js'

// --- ablation flags (attached at consumers, not producers) -------------------
export {
  type ConsumerFlags,
  DEFAULT_CONSUMER_FLAGS,
  consumerFlagsSchema,
  parseConsumerFlags,
  embeddableText,
  selectQueryTimeArtifacts,
} from './consumer-flags.js'

// --- tree-level enrichment ---------------------------------------------------
export {
  crossReferenceEdgeSchema,
  type CrossReferenceEdge,
  definitionsIndexSchema,
  type DefinitionsIndex,
  amendmentFlagSchema,
  type AmendmentFlag,
  TREE_PASSES,
  type TreePass,
  type TreeEnrichment,
  treeCacheKey,
  treeSystemPrompt,
  treeUserContent,
  type EnrichTreeDeps,
  enrichTree,
} from './tree-enrichment.js'

// --- chunk-level enrichment --------------------------------------------------
export {
  SITUATING_CONTEXT_PASS,
  type SituatedChunk,
  type ChunkEnrichment,
  type EnrichChunksDeps,
  type SituatingContextRequestInput,
  buildSituatingContextRequest,
  type SituatingAnswer,
  parseSituatingContextResponse,
  enrichChunks,
} from './chunk-enrichment.js'

// --- the build entry point ---------------------------------------------------
export {
  type EnrichmentBuild,
  type RunEnrichmentBuildInput,
  runEnrichmentBuild,
} from './pipeline.js'
