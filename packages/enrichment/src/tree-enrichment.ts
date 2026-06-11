/**
 * Tree-level enrichment (ADR 0004): the per-document sidecars that flesh out the
 * deterministic tree without ever re-authoring it. Three LLM passes run over the
 * parsed document — recovering the cross-reference graph ("despite section 12" →
 * an edge), the definitions index (defined term → the path where it is defined),
 * and amendment flags (paths "not yet in force") — and fold into one
 * {@link TreeEnrichment} sidecar.
 *
 * The properties this module guarantees, and the issue-#13 criteria they serve:
 *
 *   - Keyed to the tree hash, so it survives chunker changes — these passes only
 *     ever see the tree (skeleton path keys + per-path text), never chunks.
 *   - Cached per pass under a lossless JSON-array key
 *     `['tree', pass, model, promptVersion, treeHash]`, with the
 *     RAW response text stored so a cache hit skips the client entirely: a re-run
 *     on unchanged inputs is 100% hits and zero LLM calls. Bumping one pass's
 *     prompt version re-runs only that pass (the version is part of its key).
 *   - Exactly one client call per pass per document — the whole document is
 *     batched into each request, never one call per node.
 *   - LLM output is untyped input: parsed with zod and rejected on malformed JSON
 *     or schema mismatch. Every path the LLM returns must already exist in the
 *     document, so enrichment can never invent a citable path (the anti-
 *     hallucination fidelity guard).
 *   - Pure over the input: the {@link ParsedDocument} is never mutated.
 */

import { walkTree } from '@owners-manual/core'
import { pathKey, type ParsedDocument } from '@owners-manual/parser'
import { z } from 'zod'

import type { ClaudeClient } from './claude-client.js'
import type { EnrichmentCache } from './cache.js'
import { hashTree } from './tree-hash.js'

// --- artifacts ---------------------------------------------------------------

/**
 * A recovered in-text reference as a directed edge between two citable paths.
 * `kind` is an open label (e.g. 'despite', 'subject-to') — deliberately a string
 * and not an enum, so a new reference idiom never needs a schema change.
 */
export const crossReferenceEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    kind: z.string().min(1),
  })
  .strict()

export type CrossReferenceEdge = z.infer<typeof crossReferenceEdgeSchema>

/** Maps a defined term to the {@link pathKey} of the unit that defines it. */
export const definitionsIndexSchema = z.record(z.string().min(1), z.string().min(1))

export type DefinitionsIndex = Readonly<Record<string, string>>

/** Marks a citable path with a status note (e.g. 'not yet in force'). */
export const amendmentFlagSchema = z
  .object({
    path: z.string().min(1),
    note: z.string().min(1),
  })
  .strict()

export type AmendmentFlag = z.infer<typeof amendmentFlagSchema>

// --- passes ------------------------------------------------------------------

/** The three tree-level enrichment passes, in a stable order. */
export const TREE_PASSES = ['cross-references', 'definitions', 'amendment-flags'] as const

export type TreePass = (typeof TREE_PASSES)[number]

/** The assembled tree-level sidecar for one document, pinned to its tree hash. */
export interface TreeEnrichment {
  readonly documentId: string
  readonly treeHash: string
  readonly model: string
  readonly promptVersions: Readonly<Record<TreePass, string>>
  readonly crossReferences: readonly CrossReferenceEdge[]
  readonly definitions: DefinitionsIndex
  readonly amendmentFlags: readonly AmendmentFlag[]
}

// --- response envelopes (the JSON shape each pass must return) ----------------

const crossReferencesResponseSchema = z
  .object({ edges: z.array(crossReferenceEdgeSchema) })
  .strict()

const definitionsResponseSchema = z.object({ definitions: definitionsIndexSchema }).strict()

const amendmentFlagsResponseSchema = z.object({ flags: z.array(amendmentFlagSchema) }).strict()

// --- cache keying ------------------------------------------------------------

/**
 * The per-pass cache key: content-addressed by the tree hash, namespaced by the
 * enrichment model, and versioned by the pass's prompt. Two runs collide (a hit)
 * iff the tree, the model, and that pass's prompt are all unchanged — a persisted
 * cache must never serve one model's sidecars under another model's label.
 *
 * Encoded as a deterministic JSON array rather than a colon-joined string: model
 * and prompt-version are unconstrained, so a colon-joined `tree:<pass>:<model>:
 * <version>:<hash>` aliases distinct (model, version) pairs — `('m:v1','p')` and
 * `('m','v1:p')` would collide and a persisted cache could serve a stale entry
 * across the model/prompt boundary. The JSON array is lossless: each field is its
 * own element, so no choice of separators can fold two distinct keys together.
 */
export function treeCacheKey(
  pass: TreePass,
  model: string,
  promptVersion: string,
  parsed: ParsedDocument,
): string {
  return JSON.stringify(['tree', pass, model, promptVersion, hashTree(parsed)])
}

// --- prompt construction (pure helpers, exported for testability) ------------

const PASS_TASKS: Readonly<Record<TreePass, string>> = {
  'cross-references':
    'Recover in-text cross-references between provisions as directed edges. ' +
    'Respond with strict JSON {"edges":[{"from":<pathKey>,"to":<pathKey>,"kind":<label>}]}. ' +
    'Every from/to MUST be a pathKey present in the document. Do not invent paths. ' +
    'Do not rewrite any operative text.',
  definitions:
    'Index defined terms to the pathKey of the provision that defines each term. ' +
    'Respond with strict JSON {"definitions":{<term>:<pathKey>}}. ' +
    'Every pathKey MUST be present in the document. Do not invent paths. ' +
    'Do not rewrite any operative text.',
  'amendment-flags':
    'Flag provisions that are not yet in force (or otherwise amended). ' +
    'Respond with strict JSON {"flags":[{"path":<pathKey>,"note":<status>}]}. ' +
    'Every path MUST be a pathKey present in the document. Do not invent paths. ' +
    'Do not rewrite any operative text.',
}

/**
 * The system prompt for one pass. It carries a routable `pass:<name>` marker and
 * the pass's prompt version, so a version bump genuinely changes the request the
 * model sees (and not just the cache key around it).
 */
export function treeSystemPrompt(pass: TreePass, promptVersion: string): string {
  return [`pass:${pass} (prompt ${promptVersion})`, PASS_TASKS[pass]].join('\n')
}

/**
 * The user content for any pass: the whole document, batched — the skeleton path
 * keys in document order plus each path's operative text. One payload, never one
 * call per node, and the only thing the model is given to reason over.
 */
export function treeUserContent(parsed: ParsedDocument): string {
  const skeleton = documentPathKeys(parsed)
  const text = skeleton.map((key) => ({ path: key, text: parsed.text.get(key) ?? null }))
  return JSON.stringify({ documentId: parsed.tree.documentId, skeleton, text })
}

// --- path integrity ----------------------------------------------------------

/** Every citable-path key in the document, in document order. */
function documentPathKeys(parsed: ParsedDocument): string[] {
  const keys: string[] = []
  walkTree(parsed.tree, (_node, path) => {
    keys.push(pathKey(path))
  })
  return keys
}

/**
 * Asserts a pathKey exists in the document, throwing with the offending key when
 * it does not. This is the anti-hallucination guard: enrichment can reference
 * only paths the deterministic parse already produced, never invent one.
 */
function assertKnownPath(key: string, known: ReadonlySet<string>, where: string): void {
  if (!known.has(key)) {
    throw new Error(`tree enrichment ${where}: unknown pathKey not present in document: ${key}`)
  }
}

// --- response parsing --------------------------------------------------------

/** Parse the client's text as JSON, rejecting malformed output descriptively. */
function parseJson(text: string, pass: TreePass): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`tree enrichment ${pass}: response was not valid JSON: ${detail}`)
  }
}

function parseCrossReferences(
  text: string,
  known: ReadonlySet<string>,
): readonly CrossReferenceEdge[] {
  const { edges } = crossReferencesResponseSchema.parse(parseJson(text, 'cross-references'))
  for (const edge of edges) {
    assertKnownPath(edge.from, known, 'cross-references.from')
    assertKnownPath(edge.to, known, 'cross-references.to')
  }
  return edges
}

function parseDefinitions(text: string, known: ReadonlySet<string>): DefinitionsIndex {
  const { definitions } = definitionsResponseSchema.parse(parseJson(text, 'definitions'))
  for (const term of Object.keys(definitions)) {
    assertKnownPath(definitions[term]!, known, `definitions[${term}]`)
  }
  return definitions
}

function parseAmendmentFlags(text: string, known: ReadonlySet<string>): readonly AmendmentFlag[] {
  const { flags } = amendmentFlagsResponseSchema.parse(parseJson(text, 'amendment-flags'))
  for (const flag of flags) {
    assertKnownPath(flag.path, known, 'amendment-flags.path')
  }
  return flags
}

// --- orchestration -----------------------------------------------------------

/** Dependencies for {@link enrichTree}: the injected client, cache, and versions. */
export interface EnrichTreeDeps {
  readonly client: ClaudeClient
  readonly cache: EnrichmentCache<string>
  readonly promptVersions: Readonly<Record<TreePass, string>>
}

/**
 * Run one pass through the cache: on a miss, exactly one client call carrying the
 * whole batched document; on a hit, the stored raw text and no client call. The
 * RAW response is what is cached, so the producer (and thus the model) is skipped
 * on a hit — the property the 100%-hit re-run criterion rests on.
 */
async function runPass(
  pass: TreePass,
  parsed: ParsedDocument,
  user: string,
  deps: EnrichTreeDeps,
): Promise<string> {
  const promptVersion = deps.promptVersions[pass]
  const key = treeCacheKey(pass, deps.client.model, promptVersion, parsed)
  return deps.cache.getOrCompute(key, async () => {
    const response = await deps.client.complete({
      system: treeSystemPrompt(pass, promptVersion),
      user,
    })
    return response.text
  })
}

/**
 * Enrich one parsed document into its tree-level sidecar: one cached client call
 * per pass, the whole document batched into each, the untyped responses validated
 * and path-checked, and the results pinned to the tree hash and model. Never
 * mutates `parsed`; throws on malformed output or any invented path.
 */
export async function enrichTree(
  parsed: ParsedDocument,
  deps: EnrichTreeDeps,
): Promise<TreeEnrichment> {
  const known = new Set(documentPathKeys(parsed))
  const user = treeUserContent(parsed)

  const [crossText, defText, amendText] = await Promise.all([
    runPass('cross-references', parsed, user, deps),
    runPass('definitions', parsed, user, deps),
    runPass('amendment-flags', parsed, user, deps),
  ])

  return {
    documentId: parsed.tree.documentId,
    treeHash: hashTree(parsed),
    model: deps.client.model,
    promptVersions: deps.promptVersions,
    crossReferences: parseCrossReferences(crossText, known),
    definitions: parseDefinitions(defText, known),
    amendmentFlags: parseAmendmentFlags(amendText, known),
  }
}
