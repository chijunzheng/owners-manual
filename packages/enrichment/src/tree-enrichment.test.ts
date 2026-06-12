import { describe, expect, it } from 'vitest'

import type { ParsedDocument } from '@owners-manual/parser'

import { type ClaudeRequest, type FakeResponder, fakeClaudeClient } from './claude-client.js'
import { createMemoryCache } from './cache.js'
import { hashTree } from './tree-hash.js'
import {
  TREE_PASSES,
  amendmentFlagSchema,
  crossReferenceEdgeSchema,
  definitionsIndexSchema,
  enrichTree,
  treeCacheKey,
  treeSystemPrompt,
  type TreeEnrichment,
  type TreePass,
} from './tree-enrichment.js'

/**
 * Slice B: tree-level enrichment (ADR 0004) — per-document sidecars
 * (cross-reference graph, definitions index, amendment flags) computed by LLM
 * passes over the deterministic tree, keyed to the tree hash, cached per stage,
 * batched per document (never one call per node), never touching operative text.
 *
 * These tests pin the issue-#13 criteria the slice serves: 3 client calls for an
 * uncached document (one per pass, whole document batched), 100% cache hits on a
 * re-run with unchanged inputs, a prompt-version bump re-calls only that pass,
 * malformed LLM output is rejected, and an enrichment can never invent a citable
 * path — every from/to/definition/flag path must already exist in the document.
 */

// --- synthetic ParsedDocument builders (mirroring tree-hash.test.ts) ----------

const sectionNode = (label: string) => ({
  kind: 'section' as const,
  label,
  children: [],
})

const doc = (documentId: string, text: Array<[string, string]>): ParsedDocument => ({
  tree: {
    kind: 'document',
    label: documentId,
    documentId,
    children: text.map(([key]) => sectionNode(key.split(':').pop() ?? key)),
  },
  text: new Map(text),
})

const sample = doc('RTA', [
  ['RTA|section:2', 'In this Act, "Board" means the Landlord and Tenant Board.'],
  ['RTA|section:12', 'Despite section 2, a notice is valid if given in writing.'],
  ['RTA|section:241', 'This section is not yet in force.'],
])

const promptVersions: Readonly<Record<TreePass, string>> = {
  'cross-references': 'xref-v1',
  definitions: 'def-v1',
  'amendment-flags': 'amend-v1',
}

// --- scripted fake: route on the pass embedded in the system prompt -----------

/** Which pass a request is for, recovered from the marker in the system prompt. */
const passOf = (request: ClaudeRequest): TreePass => {
  const found = TREE_PASSES.find((pass) => request.system.includes(`pass:${pass}`))
  if (!found) throw new Error(`test responder: no pass marker in system prompt`)
  return found
}

/** A valid response per pass over the `sample` document. */
const validResponses: Readonly<Record<TreePass, string>> = {
  'cross-references': JSON.stringify({
    edges: [{ from: 'RTA|section:12', to: 'RTA|section:2', kind: 'despite' }],
  }),
  definitions: JSON.stringify({
    definitions: { Board: 'RTA|section:2' },
  }),
  'amendment-flags': JSON.stringify({
    flags: [{ path: 'RTA|section:241', note: 'not yet in force' }],
  }),
}

const validResponder: FakeResponder = (request) => validResponses[passOf(request)]

const newCache = () => createMemoryCache<string>()

describe('schemas', () => {
  it('crossReferenceEdgeSchema accepts a well-formed edge', () => {
    expect(() =>
      crossReferenceEdgeSchema.parse({ from: 'a', to: 'b', kind: 'despite' }),
    ).not.toThrow()
  })

  it('crossReferenceEdgeSchema rejects an empty kind label', () => {
    expect(() => crossReferenceEdgeSchema.parse({ from: 'a', to: 'b', kind: '' })).toThrow()
  })

  it('definitionsIndexSchema accepts a term -> path map', () => {
    expect(() => definitionsIndexSchema.parse({ Board: 'RTA|section:2' })).not.toThrow()
  })

  it('amendmentFlagSchema rejects a missing note', () => {
    expect(() => amendmentFlagSchema.parse({ path: 'RTA|section:241' })).toThrow()
  })
})

describe('treeCacheKey', () => {
  it('encodes the key as a deterministic JSON array (content-addressed by tree hash, namespaced by model, versioned by the pass prompt)', () => {
    expect(treeCacheKey('cross-references', 'fake-claude-0', 'xref-v1', sample)).toBe(
      JSON.stringify(['tree', 'cross-references', 'fake-claude-0', 'xref-v1', hashTree(sample)]),
    )
  })

  it('changes when only the prompt version changes', () => {
    expect(treeCacheKey('definitions', 'fake-claude-0', 'def-v1', sample)).not.toBe(
      treeCacheKey('definitions', 'fake-claude-0', 'def-v2', sample),
    )
  })

  it('changes when only the model changes', () => {
    expect(treeCacheKey('definitions', 'model-a', 'def-v1', sample)).not.toBe(
      treeCacheKey('definitions', 'model-b', 'def-v1', sample),
    )
  })

  it('is collision-safe across the model/prompt boundary (a colon-joined key would alias these)', () => {
    // The old `tree:<pass>:<model>:<version>:<hash>` colon-joined encoding aliases
    // these two distinct (model, version) pairs to the same string. The lossless
    // JSON-array encoding must keep them distinct.
    expect(treeCacheKey('definitions', 'm:v1', 'p', sample)).not.toBe(
      treeCacheKey('definitions', 'm', 'v1:p', sample),
    )
  })
})

describe('treeSystemPrompt', () => {
  it('embeds the routable pass marker and its prompt version', () => {
    const prompt = treeSystemPrompt('cross-references', 'xref-v9')
    expect(prompt).toContain('pass:cross-references')
    expect(prompt).toContain('xref-v9')
  })
})

describe('enrichTree', () => {
  it('makes exactly one client call per pass for an uncached document', async () => {
    const client = fakeClaudeClient({ responder: validResponder })
    await enrichTree(sample, { client, cache: newCache(), promptVersions })
    expect(client.calls).toHaveLength(3)
    const passes = client.calls.map((c) => passOf(c)).sort()
    expect(passes).toEqual(['amendment-flags', 'cross-references', 'definitions'])
  })

  it('batches the whole document into each call (skeleton paths + per-path text)', async () => {
    const client = fakeClaudeClient({ responder: validResponder })
    await enrichTree(sample, { client, cache: newCache(), promptVersions })
    for (const call of client.calls) {
      expect(call.user).toContain('RTA|section:2')
      expect(call.user).toContain('RTA|section:12')
      expect(call.user).toContain('RTA|section:241')
      expect(call.user).toContain('Despite section 2')
    }
  })

  it('rounds valid scripted artifacts into a TreeEnrichment', async () => {
    const client = fakeClaudeClient({ responder: validResponder })
    const result = await enrichTree(sample, { client, cache: newCache(), promptVersions })
    expect(result.crossReferences).toEqual([
      { from: 'RTA|section:12', to: 'RTA|section:2', kind: 'despite' },
    ])
    expect(result.definitions).toEqual({ Board: 'RTA|section:2' })
    expect(result.amendmentFlags).toEqual([{ path: 'RTA|section:241', note: 'not yet in force' }])
  })

  it('records the tree hash, model, and prompt versions on the artifact', async () => {
    const client = fakeClaudeClient({ model: 'claude-tree-0', responder: validResponder })
    const result = await enrichTree(sample, { client, cache: newCache(), promptVersions })
    expect(result.documentId).toBe('RTA')
    expect(result.treeHash).toBe(hashTree(sample))
    expect(result.model).toBe('claude-tree-0')
    expect(result.promptVersions).toEqual(promptVersions)
  })

  it('serves a re-run with unchanged inputs entirely from cache (zero client calls)', async () => {
    const cache = newCache()
    const first = fakeClaudeClient({ responder: validResponder })
    await enrichTree(sample, { client: first, cache, promptVersions })

    cache.resetStats()
    const second = fakeClaudeClient({ responder: validResponder })
    const result = await enrichTree(sample, { client: second, cache, promptVersions })

    expect(second.calls).toHaveLength(0)
    expect(cache.stats()).toEqual({ hits: 3, misses: 0 })
    expect(result.crossReferences).toHaveLength(1)
  })

  it('re-runs every pass when the model changes under a persisted cache (no stale cross-model hits)', async () => {
    const cache = newCache()
    const first = fakeClaudeClient({ model: 'model-a', responder: validResponder })
    await enrichTree(sample, { client: first, cache, promptVersions })

    const second = fakeClaudeClient({ model: 'model-b', responder: validResponder })
    const result = await enrichTree(sample, { client: second, cache, promptVersions })

    expect(second.calls).toHaveLength(3)
    expect(result.model).toBe('model-b')
  })

  it('re-calls only the bumped pass when one prompt version changes', async () => {
    const cache = newCache()
    const first = fakeClaudeClient({ responder: validResponder })
    await enrichTree(sample, { client: first, cache, promptVersions })

    const bumped: Readonly<Record<TreePass, string>> = { ...promptVersions, definitions: 'def-v2' }
    const second = fakeClaudeClient({ responder: validResponder })
    await enrichTree(sample, { client: second, cache, promptVersions: bumped })

    expect(second.calls).toHaveLength(1)
    expect(passOf(second.calls[0]!)).toBe('definitions')
  })

  it('does not poison the cache with a malformed response — a retry re-calls the client', async () => {
    const cache = newCache()
    let defCalls = 0
    const client = fakeClaudeClient({
      responder: (req) => {
        const pass = passOf(req)
        if (pass === 'definitions') {
          defCalls += 1
          if (defCalls === 1) return 'not json at all {'
        }
        return validResponses[pass]
      },
    })

    await expect(enrichTree(sample, { client, cache, promptVersions })).rejects.toThrow(/JSON/i)

    const result = await enrichTree(sample, { client, cache, promptVersions })
    expect(defCalls).toBe(2)
    expect(result.definitions).toEqual({ Board: 'RTA|section:2' })
  })

  it('does not poison the cache with a hallucinated path — a retry re-calls the client', async () => {
    const cache = newCache()
    let defCalls = 0
    const client = fakeClaudeClient({
      responder: (req) => {
        const pass = passOf(req)
        if (pass === 'definitions') {
          defCalls += 1
          if (defCalls === 1) return JSON.stringify({ definitions: { Ghost: 'RTA|section:999' } })
        }
        return validResponses[pass]
      },
    })

    await expect(enrichTree(sample, { client, cache, promptVersions })).rejects.toThrow(
      /RTA\|section:999/,
    )

    const result = await enrichTree(sample, { client, cache, promptVersions })
    expect(defCalls).toBe(2)
    expect(result.definitions).toEqual({ Board: 'RTA|section:2' })
  })

  it('rejects malformed JSON from the client', async () => {
    const client = fakeClaudeClient({
      responder: (req) =>
        passOf(req) === 'definitions' ? 'not json at all {' : validResponses[passOf(req)],
    })
    await expect(enrichTree(sample, { client, cache: newCache(), promptVersions })).rejects.toThrow(
      /JSON/i,
    )
  })

  it('rejects a response that violates the artifact schema', async () => {
    const client = fakeClaudeClient({
      responder: (req) =>
        passOf(req) === 'cross-references'
          ? JSON.stringify({ edges: [{ from: 'RTA|section:12', to: 'RTA|section:2' }] })
          : validResponses[passOf(req)],
    })
    await expect(
      enrichTree(sample, { client, cache: newCache(), promptVersions }),
    ).rejects.toThrow()
  })

  it('rejects an unknown pathKey in a cross-reference edge, naming the offender', async () => {
    const client = fakeClaudeClient({
      responder: (req) =>
        passOf(req) === 'cross-references'
          ? JSON.stringify({
              edges: [{ from: 'RTA|section:12', to: 'RTA|section:999', kind: 'despite' }],
            })
          : validResponses[passOf(req)],
    })
    await expect(enrichTree(sample, { client, cache: newCache(), promptVersions })).rejects.toThrow(
      /RTA\|section:999/,
    )
  })

  it('rejects an unknown pathKey in the definitions index', async () => {
    const client = fakeClaudeClient({
      responder: (req) =>
        passOf(req) === 'definitions'
          ? JSON.stringify({ definitions: { Board: 'RTA|section:nope' } })
          : validResponses[passOf(req)],
    })
    await expect(enrichTree(sample, { client, cache: newCache(), promptVersions })).rejects.toThrow(
      /RTA\|section:nope/,
    )
  })

  it('rejects an unknown pathKey in an amendment flag', async () => {
    const client = fakeClaudeClient({
      responder: (req) =>
        passOf(req) === 'amendment-flags'
          ? JSON.stringify({ flags: [{ path: 'RTA|section:ghost', note: 'x' }] })
          : validResponses[passOf(req)],
    })
    await expect(enrichTree(sample, { client, cache: newCache(), promptVersions })).rejects.toThrow(
      /RTA\|section:ghost/,
    )
  })

  it('never mutates the parsed document (tree hash before === after)', async () => {
    const before = hashTree(sample)
    const client = fakeClaudeClient({ responder: validResponder })
    await enrichTree(sample, { client, cache: newCache(), promptVersions })
    expect(hashTree(sample)).toBe(before)
  })

  it('accepts empty artifacts (no edges, no definitions, no flags)', async () => {
    const empty: FakeResponder = (req) => {
      switch (passOf(req)) {
        case 'cross-references':
          return JSON.stringify({ edges: [] })
        case 'definitions':
          return JSON.stringify({ definitions: {} })
        case 'amendment-flags':
          return JSON.stringify({ flags: [] })
      }
    }
    const client = fakeClaudeClient({ responder: empty })
    const result: TreeEnrichment = await enrichTree(sample, {
      client,
      cache: newCache(),
      promptVersions,
    })
    expect(result.crossReferences).toEqual([])
    expect(result.definitions).toEqual({})
    expect(result.amendmentFlags).toEqual([])
  })
})
