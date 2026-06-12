/**
 * Chunk-level enrichment (Slice C of #13): an LLM-written SITUATING CONTEXT per
 * chunk — prose that places the chunk within its document, à la the contextual-
 * retrieval pattern. The consumer (consumer-flags' `embeddableText`) prepends it
 * at embedding time; this slice NEVER edits the chunk's own text. That is the
 * "no LLM re-authors source text" criterion at chunk level: the situating
 * context is a sidecar, the {@link SituatedChunk} carries the original chunk
 * untouched.
 *
 * Keys to chunk hash + prompt version + the consumed tree-facts digest (ADR
 * 0004; CONTEXT.md line 134), so changing the chunker re-derives chunk ids and
 * hashes and invalidates chunk-level enrichment, AND changing the cited tree-level
 * definitions/cross-references invalidates it too — while unchanged facts still
 * hit. The tree hash, and the tree-level enrichment keyed to it, are untouched.
 * Calls are BATCHED per document (ADR 0005): every cache-missing chunk is
 * covered by exactly one Claude call, never one call per chunk. A document whose
 * chunks are all cached makes zero calls — the property the build report asserts
 * for 100% cache hits on re-run.
 *
 * LLM output is untyped, so it is zod-validated at the boundary
 * ({@link parseSituatingContextResponse}) and then cross-checked for integrity:
 * every requested chunk must receive a non-empty context and the response may
 * carry no id that was not requested.
 */

import { createHash } from 'node:crypto'

import { z } from 'zod'

import { walkTree } from '@owners-manual/core'
import { pathKey, type ParsedDocument } from '@owners-manual/parser'

import { type ClaudeClient, type ClaudeRequest } from './claude-client.js'
import { type EnrichmentCache } from './cache.js'
import { hashChunk, type Chunk, type Chunker } from './chunk.js'
import { canonicalJson } from './pipeline-config.js'
import { hashTree } from './tree-hash.js'
import type { CrossReferenceEdge, DefinitionsIndex, TreeEnrichment } from './tree-enrichment.js'

/** The enrichment-pass name; the cache-key namespace and prompt-version map key. */
export const SITUATING_CONTEXT_PASS = 'situating-context'

/**
 * A chunk plus its enrichment: the ORIGINAL chunk (text untouched), its content
 * address, and the LLM-written situating context that the consumer prepends at
 * embed time. The context lives beside the text, never in place of it.
 */
export interface SituatedChunk {
  readonly chunk: Chunk
  readonly chunkHash: string
  readonly situatingContext: string
}

/**
 * The chunk-level enrichment of one document: which document, which chunker
 * produced the chunks, which model and prompt version wrote the contexts, and
 * the situated chunks in document order. The chunker id + prompt version are the
 * inputs that, when changed, invalidate this artifact's cache keys.
 */
export interface ChunkEnrichment {
  readonly documentId: string
  readonly chunkerId: string
  readonly model: string
  readonly promptVersion: string
  readonly chunks: readonly SituatedChunk[]
}

/** The dependencies injected into {@link enrichChunks}; all seams, no globals. */
export interface EnrichChunksDeps {
  /** The chunking strategy; its id namespaces chunk ids and keys invalidation. */
  readonly chunker: Chunker
  /** The injected Claude seam (the fake under test, the real adapter in prod). */
  readonly client: ClaudeClient
  /** The content-addressed per-chunk context cache (stores the context string). */
  readonly cache: EnrichmentCache<string>
  /**
   * The tree-level sidecar this document's chunk contexts consume (CONTEXT.md
   * line 134): the recovered definitions and cross-references the situating
   * context MAY cite. Required — the contexts are computed against these facts and
   * the chunk-context cache is scoped by their digest, so they cannot be optional.
   */
  readonly treeEnrichment: TreeEnrichment
  /** The situating-context prompt version; bumping it invalidates every key. */
  readonly promptVersion: string
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * The content-address of exactly the tree-level facts a chunk request embeds: a
 * SHA-256 over the canonical serialization of `{ crossReferences, definitions }`.
 *
 * The chunk situating-context cache keys on this digest, so a chunk-context entry
 * invalidates iff the consumed facts change and survives when they do not — the
 * dataflow CONTEXT.md line 134 pins (the context cites the definitions and xrefs
 * found earlier) made cache-correct. Only the two fields the request embeds enter
 * the digest; amendment flags and the tree hash are not consumed here and do not.
 */
export function treeFactsDigest(enrichment: TreeEnrichment): string {
  return sha256Hex(
    canonicalJson({
      crossReferences: enrichment.crossReferences,
      definitions: enrichment.definitions,
    }),
  )
}

/**
 * The per-chunk cache key: namespaced by pass + chunker id + model + prompt
 * version + the document's tree hash + the consumed tree-facts digest + chunk
 * hash, encoded as a lossless JSON array.
 *
 * The array (rather than a colon-joined string) is collision-safe: model and
 * prompt-version are unconstrained, so a joined `chunk:...:<model>:<version>:...`
 * key aliases distinct (model, version) pairs and could serve a stale entry
 * across that boundary. The chunker id is its own element because the Chunker
 * interface does not require strategy-prefixed chunk ids — two strategies can
 * emit byte-identical chunks, and AC2 pins that a chunker change invalidates
 * chunk-level enrichment regardless. The tree hash is its own element because a
 * situating context is written WITHIN its document — the request embeds the
 * documentId and full skeleton — so a byte-identical chunk in a different
 * document must be re-situated, never served another document's context. The
 * tree-facts digest scopes the key to the exact sidecar the context consumed,
 * so changing the cited definitions/xrefs misses.
 */
function chunkCacheKey(
  chunkerId: string,
  model: string,
  promptVersion: string,
  treeHash: string,
  treeFacts: string,
  chunkHash: string,
): string {
  return JSON.stringify([
    'chunk',
    SITUATING_CONTEXT_PASS,
    chunkerId,
    model,
    promptVersion,
    treeHash,
    treeFacts,
    chunkHash,
  ])
}

/** The document's structural skeleton: every node's path key, in document order. */
function documentSkeleton(parsed: ParsedDocument): string[] {
  const keys: string[] = []
  walkTree(parsed.tree, (_node, path) => {
    keys.push(pathKey(path))
  })
  return keys
}

/** One requested chunk as it appears in the batched request's user content. */
interface RequestChunk {
  readonly id: string
  readonly citablePathKey: string
  readonly text: string
}

/** Project a chunk to the minimal JSON the LLM needs to situate it. */
function toRequestChunk(chunk: Chunk): RequestChunk {
  return { id: chunk.id, citablePathKey: chunk.citablePathKey, text: chunk.text }
}

/** Inputs to {@link buildSituatingContextRequest}: a document plus its missing chunks. */
export interface SituatingContextRequestInput {
  readonly documentId: string
  readonly promptVersion: string
  readonly skeleton: readonly string[]
  readonly chunks: readonly Chunk[]
  /** The tree-level definitions index the situating context MAY cite (CONTEXT.md line 134). */
  readonly definitions: DefinitionsIndex
  /** The tree-level cross-reference edges the situating context MAY cite. */
  readonly crossReferences: readonly CrossReferenceEdge[]
}

/**
 * Construct the batched Claude request for a document's missing chunks. The
 * system prompt names the task and embeds the prompt VERSION (so a version bump
 * genuinely changes the request and re-keys the cache); the user content carries
 * the document skeleton for situating context, the recovered tree-level facts
 * (definitions + cross-references) the chunk context may cite, plus the missing
 * chunks as a JSON array. Pure and exported for testability.
 */
export function buildSituatingContextRequest(input: SituatingContextRequestInput): ClaudeRequest {
  const system = [
    `You are writing situating context for legal-document chunks (prompt version ${input.promptVersion}).`,
    'For each chunk, write one or two sentences situating it within its document so a retriever',
    'can place it in context. Do NOT rewrite, summarize, or alter the chunk text itself.',
    'You MAY cite the recovered definitions and cross-references provided below when this helps',
    'situate a chunk; never use them to rewrite the chunk text.',
    'Respond with ONLY a JSON array of {"id","context"} objects, one per requested chunk.',
  ].join('\n')

  const user = JSON.stringify({
    documentId: input.documentId,
    skeleton: input.skeleton,
    definitions: input.definitions,
    crossReferences: input.crossReferences,
    chunks: input.chunks.map(toRequestChunk),
  })

  return { system, user }
}

/** The validated shape of one situating-context answer from the LLM. */
const situatingAnswerSchema = z
  .object({
    id: z.string().min(1),
    context: z.string().min(1),
  })
  .strict()

/** The validated shape of a whole situating-context response: a non-empty-able array. */
const situatingResponseSchema = z.array(situatingAnswerSchema)

/** One parsed situating-context answer: a chunk id and its non-empty context. */
export type SituatingAnswer = z.infer<typeof situatingAnswerSchema>

/**
 * Parse-and-validate the untyped LLM text into situating-context answers. The
 * text must be a JSON array of {id, context} with non-empty strings; anything
 * else (non-JSON, wrong shape, empty context) throws — the untyped LLM boundary
 * is where malformed output is rejected, not where it leaks downstream.
 */
export function parseSituatingContextResponse(text: string): SituatingAnswer[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`situating-context response was not valid JSON: ${(error as Error).message}`)
  }
  return situatingResponseSchema.parse(parsed)
}

/**
 * Index validated answers by id, rejecting a response that carries any id not in
 * `requestedIds` (an unknown chunk the LLM invented). Duplicate ids collapse to
 * the last; the requested-coverage check downstream still fails if any is missing.
 */
function indexAnswers(
  answers: readonly SituatingAnswer[],
  requestedIds: ReadonlySet<string>,
): Map<string, string> {
  const byId = new Map<string, string>()
  for (const answer of answers) {
    if (!requestedIds.has(answer.id)) {
      throw new Error(`situating-context response referenced an unknown chunk id: "${answer.id}"`)
    }
    byId.set(answer.id, answer.context)
  }
  return byId
}

/**
 * Run the single batched Claude call for `missing` chunks and return a map of
 * chunk id -> situating context. Validates the response shape, rejects unknown
 * ids, and rejects a response that fails to cover any requested chunk.
 */
async function situateMissingChunks(
  parsed: ParsedDocument,
  missing: readonly Chunk[],
  deps: EnrichChunksDeps,
): Promise<Map<string, string>> {
  const request = buildSituatingContextRequest({
    documentId: parsed.tree.documentId,
    promptVersion: deps.promptVersion,
    skeleton: documentSkeleton(parsed),
    chunks: missing,
    definitions: deps.treeEnrichment.definitions,
    crossReferences: deps.treeEnrichment.crossReferences,
  })

  const response = await deps.client.complete(request)
  const answers = parseSituatingContextResponse(response.text)

  const requestedIds = new Set(missing.map((chunk) => chunk.id))
  const byId = indexAnswers(answers, requestedIds)

  for (const chunk of missing) {
    if (!byId.has(chunk.id)) {
      throw new Error(`situating-context response did not cover requested chunk id: "${chunk.id}"`)
    }
  }

  return byId
}

/**
 * Enrich a parsed document's chunks with LLM-written situating context. Chunks
 * via `deps.chunker`, content-addresses each, serves cached contexts as hits,
 * and covers every cache MISS with exactly one batched Claude call (zero misses
 * -> zero calls). The original chunk text is carried through untouched; nothing
 * about the parsed document or its chunks is mutated.
 */
export async function enrichChunks(
  parsed: ParsedDocument,
  deps: EnrichChunksDeps,
): Promise<ChunkEnrichment> {
  const chunks = deps.chunker.chunk(parsed)
  const hashes = chunks.map(hashChunk)
  const treeFacts = treeFactsDigest(deps.treeEnrichment)
  const treeIdentity = hashTree(parsed)

  const missing = chunks.filter((_chunk, index) => {
    const key = chunkCacheKey(
      deps.chunker.id,
      deps.client.model,
      deps.promptVersion,
      treeIdentity,
      treeFacts,
      hashes[index]!,
    )
    return !cacheHas(deps.cache, key)
  })

  const situated =
    missing.length > 0
      ? await situateMissingChunks(parsed, missing, deps)
      : new Map<string, string>()

  const enrichedChunks = await Promise.all(
    chunks.map(async (chunk, index): Promise<SituatedChunk> => {
      const chunkHash = hashes[index]!
      const key = chunkCacheKey(
        deps.chunker.id,
        deps.client.model,
        deps.promptVersion,
        treeIdentity,
        treeFacts,
        chunkHash,
      )
      const situatingContext = await deps.cache.getOrCompute(key, async () => {
        const fresh = situated.get(chunk.id)
        if (fresh === undefined) {
          throw new Error(`no situating context produced for chunk id: "${chunk.id}"`)
        }
        return fresh
      })
      // A cache HIT bypasses the producer (and situateMissingChunks' non-empty
      // guard), so a corrupt or stale snapshot entry must be re-checked on the
      // way out — fresh outputs are rejected for emptiness, and cached ones
      // get the same bar instead of silently flowing into the sidecar.
      if (situatingContext === '') {
        throw new Error(
          `cached situating context for chunk id "${chunk.id}" is empty — ` +
            'the cache entry is corrupt; evict it and rebuild',
        )
      }
      return { chunk, chunkHash, situatingContext }
    }),
  )

  return {
    documentId: parsed.tree.documentId,
    chunkerId: deps.chunker.id,
    model: deps.client.model,
    promptVersion: deps.promptVersion,
    chunks: enrichedChunks,
  }
}

/**
 * Probe whether a key is already cached without recording a hit/miss against the
 * stats: a snapshot is a serializable view of the stored entries, so presence of
 * the key there is the cache-membership test. This keeps the producer-call
 * accounting (the call count under test) decoupled from the pre-pass membership
 * check used to decide what to batch.
 */
function cacheHas(cache: EnrichmentCache<string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(cache.snapshot(), key)
}
