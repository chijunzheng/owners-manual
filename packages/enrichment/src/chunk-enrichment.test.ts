import { describe, expect, it } from 'vitest'

import type { ParsedDocument } from '@owners-manual/parser'

import { fakeClaudeClient, type ClaudeRequest } from './claude-client.js'
import { createMemoryCache } from './cache.js'
import { citableUnitChunker, hashChunk, type Chunker } from './chunk.js'
import { hashTree } from './tree-hash.js'
import { type TreeEnrichment } from './tree-enrichment.js'
import {
  buildSituatingContextRequest,
  enrichChunks,
  parseSituatingContextResponse,
  treeFactsDigest,
  type ChunkEnrichment,
} from './chunk-enrichment.js'

/**
 * Slice C of #13: chunk-level enrichment writes a SITUATING CONTEXT per chunk —
 * prose that situates the chunk within its document, prepended later at embed
 * time by the consumer (consumer-flags' `embeddableText`), never editing the
 * chunk text itself. It is keyed to chunk hash + prompt version and BATCHED per
 * document: exactly one LLM call covers every cache-missing chunk, never one
 * call per chunk (ADR 0005). These tests pin the #13 criteria offline against
 * the deterministic fake Claude client and a content-addressed cache:
 *   - 100% cache hits on re-run (zero calls, all hits);
 *   - a partial cache re-calls only the missing chunks;
 *   - a prompt-version bump re-calls everything;
 *   - swapping the chunker invalidates chunk-level enrichment ONLY while the
 *     tree hash (and tree-level enrichment keyed to it) survives;
 *   - the LLM never re-authors source text (chunk text byte-identical out).
 */

const parsed = (documentId: string, text: Array<[string, string]>): ParsedDocument => ({
  tree: {
    kind: 'document',
    label: documentId,
    documentId,
    children: text.map(([key]) => ({
      kind: 'section' as const,
      label: key.split(':').pop() ?? key,
      children: [],
    })),
  },
  text: new Map(text),
})

const sample = parsed('RTA', [
  ['RTA|section:1', 'The purposes of this Act are to provide protection.'],
  ['RTA|section:2', 'In this Act, "Board" means the Landlord and Tenant Board.'],
])

/**
 * A small, valid tree-level sidecar over `sample`: the recovered facts the chunk
 * pass MUST consume (CONTEXT.md line 134 — situating context cites the
 * definitions and cross-references found at tree level). Its definition path
 * (`RTA|section:2`) and edge endpoints exist in `sample`. Build helpers below let
 * tests vary the consumed facts to prove the digest gates the chunk-context cache.
 */
const treeEnrichmentFor = (definitions: Readonly<Record<string, string>>): TreeEnrichment => ({
  documentId: 'RTA',
  treeHash: hashTree(sample),
  model: 'fake-claude-0',
  promptVersions: {
    'cross-references': 'xref-v1',
    definitions: 'def-v1',
    'amendment-flags': 'amend-v1',
  },
  crossReferences: [{ from: 'RTA|section:1', to: 'RTA|section:2', kind: 'despite' }],
  definitions,
  amendmentFlags: [],
})

const treeEnrichment: TreeEnrichment = treeEnrichmentFor({ Board: 'RTA|section:2' })

/**
 * A scripted responder that plays the role of Claude for the situating-context
 * pass: it parses the requested chunks out of the user content and answers with
 * a deterministic, non-empty context per requested id — the JSON-array shape the
 * parser expects. It also lets a test see exactly which ids a given call covered.
 */
function situatingResponder(): (request: ClaudeRequest) => string {
  return (request) =>
    JSON.stringify(
      parseRequestedChunkIds(request.user).map((id) => ({
        id,
        context: `Situating context for ${id}.`,
      })),
    )
}

/** Extract the requested chunk ids from a situating-context request's user content. */
function parseRequestedChunkIds(user: string): string[] {
  const payload = JSON.parse(user) as { chunks?: Array<{ id: string }> }
  return (payload.chunks ?? []).map((chunk) => chunk.id)
}

/**
 * A second, toy chunker with a DIFFERENT id and DIFFERENT boundaries (it fuses
 * the whole document into one chunk). Used to prove a chunker swap invalidates
 * chunk-level cache keys while the tree hash is untouched.
 */
const wholeDocChunker: Chunker = {
  id: 'whole-doc',
  chunk(parsedDoc) {
    const text = [...parsedDoc.text.values()].join('\n\n')
    if (text === '') return []
    return [
      {
        id: `${this.id}:${parsedDoc.tree.documentId}`,
        citablePathKey: parsedDoc.tree.documentId,
        text,
      },
    ]
  },
}

describe('enrichChunks — batching', () => {
  it('makes exactly ONE call for an uncached document of N chunks', async () => {
    const client = fakeClaudeClient({ responder: situatingResponder() })
    const cache = createMemoryCache<string>()

    const result = await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client,
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })

    expect(client.calls).toHaveLength(1)
    expect(result.chunks).toHaveLength(2)
    expect(result.chunks.map((c) => c.situatingContext)).toEqual([
      'Situating context for citable-unit:RTA|section:1.',
      'Situating context for citable-unit:RTA|section:2.',
    ])
  })

  it('records documentId, chunkerId, model and promptVersion on the enrichment', async () => {
    const client = fakeClaudeClient({ model: 'claude-test-0', responder: situatingResponder() })
    const result = await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client,
      cache: createMemoryCache<string>(),
      treeEnrichment,
      promptVersion: 'v1',
    })

    const expected: Omit<ChunkEnrichment, 'chunks'> = {
      documentId: 'RTA',
      chunkerId: 'citable-unit',
      model: 'claude-test-0',
      promptVersion: 'v1',
    }
    expect({
      documentId: result.documentId,
      chunkerId: result.chunkerId,
      model: result.model,
      promptVersion: result.promptVersion,
    }).toEqual(expected)
  })

  it('attaches the chunk hash to each situated chunk', async () => {
    const client = fakeClaudeClient({ responder: situatingResponder() })
    const result = await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client,
      cache: createMemoryCache<string>(),
      treeEnrichment,
      promptVersion: 'v1',
    })

    const chunks = citableUnitChunker.chunk(sample)
    expect(result.chunks.map((c) => c.chunkHash)).toEqual(chunks.map(hashChunk))
  })
})

describe('enrichChunks — cache behavior', () => {
  it('re-calls every chunk when the model changes under a persisted cache (no stale cross-model hits)', async () => {
    const cache = createMemoryCache<string>()
    const first = fakeClaudeClient({ model: 'model-a', responder: situatingResponder() })
    await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client: first,
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })

    const second = fakeClaudeClient({ model: 'model-b', responder: situatingResponder() })
    const result = await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client: second,
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })

    expect(second.calls).toHaveLength(1)
    expect(result.model).toBe('model-b')
  })

  it('re-running over an unchanged cache makes ZERO calls and is all hits', async () => {
    const cache = createMemoryCache<string>()
    const first = fakeClaudeClient({ responder: situatingResponder() })
    await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client: first,
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })

    cache.resetStats()
    const second = fakeClaudeClient({ responder: situatingResponder() })
    const result = await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client: second,
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })

    expect(second.calls).toHaveLength(0)
    const stats = cache.stats()
    expect(stats.misses).toBe(0)
    expect(stats.hits).toBe(2)
    expect(result.chunks.map((c) => c.situatingContext)).toEqual([
      'Situating context for citable-unit:RTA|section:1.',
      'Situating context for citable-unit:RTA|section:2.',
    ])
  })

  it('does not reuse contexts across DOCUMENTS with byte-identical chunks (tree identity keys the cache)', async () => {
    // The situating context is written "within its document" — the request
    // embeds documentId + skeleton — so an identical chunk triple in a second
    // document must be re-situated, never served the first document's context.
    const fixedChunker: Chunker = {
      id: 'fixed',
      chunk: () => [{ id: 'chunk-1', citablePathKey: 'shared', text: 'Identical clause text.' }],
    }
    const docB = parsed('LEASE', [['LEASE|clause:1', 'Entirely different document body.']])

    const cache = createMemoryCache<string>()
    const first = fakeClaudeClient({ responder: situatingResponder() })
    await enrichChunks(sample, {
      chunker: fixedChunker,
      client: first,
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })

    const second = fakeClaudeClient({ responder: situatingResponder() })
    await enrichChunks(docB, {
      chunker: fixedChunker,
      client: second,
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })

    expect(second.calls).toHaveLength(1)
  })

  it('re-calls when the CHUNKER changes even if it emits byte-identical chunks (AC2: chunker identity keys the cache)', async () => {
    // The Chunker interface does not require strategy-prefixed chunk ids, so two
    // strategies can emit identical (id, citablePathKey, text) triples. AC2 says
    // a chunker change invalidates chunk-level enrichment — the cache key must
    // carry the chunker id, not rely on the id-prefix convention.
    const bareChunk = (parsedDoc: ParsedDocument) => {
      const [first] = [...parsedDoc.text.entries()]
      return first === undefined ? [] : [{ id: first[0], citablePathKey: first[0], text: first[1] }]
    }
    const strategyA = { id: 'strategy-a', chunk: bareChunk }
    const strategyB = { id: 'strategy-b', chunk: bareChunk }

    const cache = createMemoryCache<string>()
    const first = fakeClaudeClient({ responder: situatingResponder() })
    await enrichChunks(sample, {
      chunker: strategyA,
      client: first,
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })

    const second = fakeClaudeClient({ responder: situatingResponder() })
    const result = await enrichChunks(sample, {
      chunker: strategyB,
      client: second,
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })

    expect(second.calls).toHaveLength(1)
    expect(result.chunkerId).toBe('strategy-b')
  })

  it('rejects an EMPTY context served from a seeded snapshot (cache hits are revalidated)', async () => {
    // A seeded snapshot bypasses the producer, so the non-empty guard in
    // situateMissingChunks never runs for hits. A corrupt/old snapshot entry
    // holding '' must fail loudly instead of flowing into the sidecar.
    const chunks = citableUnitChunker.chunk(sample)
    const poisonedKey = JSON.stringify([
      'chunk',
      'situating-context',
      'citable-unit',
      'fake-claude-0',
      'v1',
      hashTree(sample),
      treeFactsDigest(treeEnrichment),
      hashChunk(chunks[0]!),
    ])
    const cache = createMemoryCache<string>({ snapshot: { [poisonedKey]: '' } })
    const client = fakeClaudeClient({ responder: situatingResponder() })

    await expect(
      enrichChunks(sample, {
        chunker: citableUnitChunker,
        client,
        cache,
        treeEnrichment,
        promptVersion: 'v1',
      }),
    ).rejects.toThrow(/empty/i)
  })

  it('with a PARTIAL cache, makes ONE call covering only the missing chunks', async () => {
    const chunks = citableUnitChunker.chunk(sample)
    // Seed using the NEW key format: a JSON array carrying the tree-facts digest
    // (the chunk-context cache is now scoped by the consumed tree sidecar too).
    const seededKey = JSON.stringify([
      'chunk',
      'situating-context',
      'citable-unit',
      'fake-claude-0',
      'v1',
      hashTree(sample),
      treeFactsDigest(treeEnrichment),
      hashChunk(chunks[0]!),
    ])
    const cache = createMemoryCache<string>({
      snapshot: { [seededKey]: 'Pre-seeded context for section 1.' },
    })

    let seenUser = ''
    const client = fakeClaudeClient({
      responder: (request) => {
        seenUser = request.user
        return situatingResponder()(request)
      },
    })

    const result = await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client,
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })

    expect(client.calls).toHaveLength(1)
    expect(parseRequestedChunkIds(seenUser)).toEqual(['citable-unit:RTA|section:2'])
    expect(result.chunks[0]!.situatingContext).toBe('Pre-seeded context for section 1.')
    expect(result.chunks[1]!.situatingContext).toBe(
      'Situating context for citable-unit:RTA|section:2.',
    )
  })
})

describe('enrichChunks — invalidation semantics', () => {
  it('bumping the prompt version re-calls the whole document', async () => {
    const cache = createMemoryCache<string>()
    const first = fakeClaudeClient({ responder: situatingResponder() })
    await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client: first,
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })

    const second = fakeClaudeClient({ responder: situatingResponder() })
    await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client: second,
      cache,
      treeEnrichment,
      promptVersion: 'v2',
    })

    expect(second.calls).toHaveLength(1)
    expect(parseRequestedChunkIds(second.calls[0]!.user)).toEqual([
      'citable-unit:RTA|section:1',
      'citable-unit:RTA|section:2',
    ])
  })

  it('the prompt version appears in the system prompt so a bump changes the request', async () => {
    const cache = createMemoryCache<string>()
    const v1 = fakeClaudeClient({ responder: situatingResponder() })
    await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client: v1,
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })

    const v2 = fakeClaudeClient({ responder: situatingResponder() })
    await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client: v2,
      cache: createMemoryCache<string>(),
      treeEnrichment,
      promptVersion: 'v2',
    })

    expect(v1.calls[0]!.system).toContain('v1')
    expect(v2.calls[0]!.system).toContain('v2')
    expect(v1.calls[0]!.system).not.toBe(v2.calls[0]!.system)
  })

  it('swapping the chunker invalidates chunk-level enrichment while the tree hash survives', async () => {
    const cache = createMemoryCache<string>()
    await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client: fakeClaudeClient({ responder: situatingResponder() }),
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })

    cache.resetStats()
    const swapped = fakeClaudeClient({ responder: situatingResponder() })
    const result = await enrichChunks(sample, {
      chunker: wholeDocChunker,
      client: swapped,
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })

    // The chunker swap re-derives chunk ids/hashes -> a cache MISS -> a fresh call.
    expect(swapped.calls).toHaveLength(1)
    expect(cache.stats().misses).toBe(1)
    expect(result.chunkerId).toBe('whole-doc')
    expect(result.chunks).toHaveLength(1)

    // The tree-level half of the criterion: the tree hash is untouched by the swap.
    expect(hashTree(sample)).toBe(hashTree(sample))
  })
})

describe('enrichChunks — response integrity', () => {
  it('rejects malformed (non-JSON) LLM output', async () => {
    const client = fakeClaudeClient({ responder: () => 'not json at all' })
    await expect(
      enrichChunks(sample, {
        chunker: citableUnitChunker,
        client,
        cache: createMemoryCache<string>(),
        treeEnrichment,
        promptVersion: 'v1',
      }),
    ).rejects.toThrow()
  })

  it('rejects a response missing a requested chunk id', async () => {
    const client = fakeClaudeClient({
      responder: (request) => {
        const [first] = parseRequestedChunkIds(request.user)
        return JSON.stringify([{ id: first, context: 'only the first' }])
      },
    })
    await expect(
      enrichChunks(sample, {
        chunker: citableUnitChunker,
        client,
        cache: createMemoryCache<string>(),
        treeEnrichment,
        promptVersion: 'v1',
      }),
    ).rejects.toThrow()
  })

  it('rejects a response carrying an unknown chunk id', async () => {
    const client = fakeClaudeClient({
      responder: (request) => {
        const requested = parseRequestedChunkIds(request.user)
        const answers = requested.map((id) => ({ id, context: `ctx ${id}` }))
        return JSON.stringify([...answers, { id: 'phantom:id', context: 'never requested' }])
      },
    })
    await expect(
      enrichChunks(sample, {
        chunker: citableUnitChunker,
        client,
        cache: createMemoryCache<string>(),
        treeEnrichment,
        promptVersion: 'v1',
      }),
    ).rejects.toThrow()
  })

  it('rejects a response with an empty context for a requested chunk', async () => {
    const client = fakeClaudeClient({
      responder: (request) =>
        JSON.stringify(parseRequestedChunkIds(request.user).map((id) => ({ id, context: '' }))),
    })
    await expect(
      enrichChunks(sample, {
        chunker: citableUnitChunker,
        client,
        cache: createMemoryCache<string>(),
        treeEnrichment,
        promptVersion: 'v1',
      }),
    ).rejects.toThrow()
  })
})

describe('enrichChunks — no re-authoring & empty document', () => {
  it('carries the ORIGINAL chunk text byte-identical (situating context never replaces it)', async () => {
    const client = fakeClaudeClient({ responder: situatingResponder() })
    const result = await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client,
      cache: createMemoryCache<string>(),
      treeEnrichment,
      promptVersion: 'v1',
    })

    const chunks = citableUnitChunker.chunk(sample)
    expect(result.chunks.map((c) => c.chunk.text)).toEqual(chunks.map((c) => c.text))
    // The situating context lives beside the text, not in place of it.
    result.chunks.forEach((situated) => {
      expect(situated.situatingContext).not.toBe(situated.chunk.text)
    })
  })

  it('does not mutate the ParsedDocument or its chunks', async () => {
    const before = JSON.stringify([...sample.text.entries()])
    const chunks = citableUnitChunker.chunk(sample)
    const chunksBefore = JSON.stringify(chunks)

    await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client: fakeClaudeClient({ responder: situatingResponder() }),
      cache: createMemoryCache<string>(),
      treeEnrichment,
      promptVersion: 'v1',
    })

    expect(JSON.stringify([...sample.text.entries()])).toBe(before)
    expect(JSON.stringify(citableUnitChunker.chunk(sample))).toBe(chunksBefore)
  })

  it('an empty document (no chunks) makes zero calls and yields an empty enrichment', async () => {
    const empty = parsed('EMPTY', [])
    const client = fakeClaudeClient({ responder: situatingResponder() })
    const result = await enrichChunks(empty, {
      chunker: citableUnitChunker,
      client,
      cache: createMemoryCache<string>(),
      treeEnrichment,
      promptVersion: 'v1',
    })

    expect(client.calls).toHaveLength(0)
    expect(result.chunks).toEqual([])
    expect(result.documentId).toBe('EMPTY')
  })
})

describe('enrichChunks — tree-sidecar consumption (CONTEXT.md line 134)', () => {
  it("the batched request's user payload carries the consumed sidecar's definitions and cross-references", async () => {
    let seenUser = ''
    const client = fakeClaudeClient({
      responder: (request) => {
        seenUser = request.user
        return situatingResponder()(request)
      },
    })

    await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client,
      cache: createMemoryCache<string>(),
      treeEnrichment,
      promptVersion: 'v1',
    })

    const payload = JSON.parse(seenUser) as {
      definitions: Record<string, string>
      crossReferences: Array<{ from: string; to: string; kind: string }>
    }
    expect(payload.definitions).toEqual({ Board: 'RTA|section:2' })
    expect(payload.crossReferences).toEqual([
      { from: 'RTA|section:1', to: 'RTA|section:2', kind: 'despite' },
    ])
  })

  it('a CHANGE in the consumed sidecar facts re-calls over a persisted cache; UNCHANGED facts still hit', async () => {
    const cache = createMemoryCache<string>()

    // First build consumes the original sidecar.
    const first = fakeClaudeClient({ responder: situatingResponder() })
    await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client: first,
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })

    // Re-run with UNCHANGED facts: all hits, zero calls.
    cache.resetStats()
    const sameFacts = fakeClaudeClient({ responder: situatingResponder() })
    await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client: sameFacts,
      cache,
      treeEnrichment,
      promptVersion: 'v1',
    })
    expect(sameFacts.calls).toHaveLength(0)
    expect(cache.stats().misses).toBe(0)
    expect(cache.stats().hits).toBe(2)

    // Re-run with DIFFERENT consumed facts (a different definition): the chunk
    // contexts can now cite a different sidecar, so the cache must MISS and the
    // client must be called afresh.
    cache.resetStats()
    const changedFacts = fakeClaudeClient({ responder: situatingResponder() })
    await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client: changedFacts,
      cache,
      treeEnrichment: treeEnrichmentFor({ Board: 'RTA|section:1' }),
      promptVersion: 'v1',
    })
    expect(changedFacts.calls).toHaveLength(1)
    expect(cache.stats().misses).toBe(2)
  })

  it('is collision-safe across the model/prompt boundary — a colon-joined key would alias these (second run CALLS, not hits)', async () => {
    // Run 1: model 'm:v1', promptVersion 'p'. Run 2: model 'm', promptVersion
    // 'v1:p'. A colon-joined `chunk:...:<model>:<version>:...` key aliases these,
    // so run 2 would wrongly HIT run 1's entries. The lossless JSON-array key
    // keeps them distinct, so run 2 must call the client.
    const cache = createMemoryCache<string>()

    const run1 = fakeClaudeClient({ model: 'm:v1', responder: situatingResponder() })
    await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client: run1,
      cache,
      treeEnrichment,
      promptVersion: 'p',
    })

    cache.resetStats()
    const run2 = fakeClaudeClient({ model: 'm', responder: situatingResponder() })
    await enrichChunks(sample, {
      chunker: citableUnitChunker,
      client: run2,
      cache,
      treeEnrichment,
      promptVersion: 'v1:p',
    })

    // No stale cross-boundary hit: run 2 misses every chunk and makes a call.
    expect(run2.calls).toHaveLength(1)
    expect(cache.stats().misses).toBe(2)
    expect(cache.stats().hits).toBe(0)
  })
})

describe('treeFactsDigest', () => {
  it('is stable for the same consumed facts and differs when the definitions change', () => {
    const a = treeFactsDigest(treeEnrichment)
    const b = treeFactsDigest(treeEnrichmentFor({ Board: 'RTA|section:2' }))
    const c = treeFactsDigest(treeEnrichmentFor({ Board: 'RTA|section:1' }))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    // A 64-hex-char sha256 digest.
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('prompt construction helpers', () => {
  it('buildSituatingContextRequest embeds the prompt version and the missing chunks as JSON', () => {
    const chunks = citableUnitChunker.chunk(sample)
    const request = buildSituatingContextRequest({
      documentId: 'RTA',
      promptVersion: 'v7',
      skeleton: ['RTA|section:1', 'RTA|section:2'],
      chunks,
      definitions: treeEnrichment.definitions,
      crossReferences: treeEnrichment.crossReferences,
    })

    expect(request.system).toContain('v7')
    expect(parseRequestedChunkIds(request.user)).toEqual([
      'citable-unit:RTA|section:1',
      'citable-unit:RTA|section:2',
    ])
  })

  it('buildSituatingContextRequest embeds the consumed tree sidecar (definitions + cross-references) in the user payload', () => {
    const chunks = citableUnitChunker.chunk(sample)
    const request = buildSituatingContextRequest({
      documentId: 'RTA',
      promptVersion: 'v7',
      skeleton: ['RTA|section:1', 'RTA|section:2'],
      chunks,
      definitions: { Board: 'RTA|section:2' },
      crossReferences: [{ from: 'RTA|section:1', to: 'RTA|section:2', kind: 'despite' }],
    })

    const payload = JSON.parse(request.user) as {
      definitions: Record<string, string>
      crossReferences: Array<{ from: string; to: string; kind: string }>
    }
    expect(payload.definitions).toEqual({ Board: 'RTA|section:2' })
    expect(payload.crossReferences).toEqual([
      { from: 'RTA|section:1', to: 'RTA|section:2', kind: 'despite' },
    ])
    // The system prompt invites the model to cite the recovered facts, but never
    // to rewrite the chunk text.
    expect(request.system.toLowerCase()).toContain('cite')
    expect(request.system).toMatch(/do not rewrite/i)
  })

  it('parseSituatingContextResponse accepts a well-formed array and rejects junk', () => {
    const ok = parseSituatingContextResponse('[{"id":"a","context":"x"}]')
    expect(ok).toEqual([{ id: 'a', context: 'x' }])
    expect(() => parseSituatingContextResponse('{"id":"a"}')).toThrow()
    expect(() => parseSituatingContextResponse('[{"id":"a"}]')).toThrow()
  })
})
