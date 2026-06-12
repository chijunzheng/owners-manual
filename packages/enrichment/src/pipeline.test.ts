import { describe, expect, it } from 'vitest'

import type { ParsedDocument } from '@owners-manual/parser'

import { walkTree } from '@owners-manual/core'
import { pathKey } from '@owners-manual/parser'

import { type ClaudeRequest, type FakeResponder, fakeClaudeClient } from './claude-client.js'
import { createMemoryCache, type EnrichmentCache } from './cache.js'
import { citableUnitChunker, type Chunker } from './chunk.js'
import {
  DEFAULT_CONSUMER_FLAGS,
  embeddableText,
  selectQueryTimeArtifacts,
} from './consumer-flags.js'
import { type PipelineConfig } from './pipeline-config.js'
import { TREE_PASSES, type TreePass } from './tree-enrichment.js'
import { hashTree } from './tree-hash.js'
import { runEnrichmentBuild } from './pipeline.js'

/**
 * The ACCEPTANCE suite for issue #13 (LLM offline enrichment track). One describe
 * block per acceptance criterion, each pinning the criterion end to end through
 * the single {@link runEnrichmentBuild} entry point that wires the completed
 * slices together. Everything runs offline against the deterministic fake Claude
 * client; ParsedDocuments are built synthetically inline.
 */

// --- synthetic ParsedDocument builders ---------------------------------------

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

/** A two-document synthetic corpus, distinct ids -> distinct tree hashes. */
const docA = doc('RTA', [
  ['RTA|section:2', 'In this Act, "Board" means the Landlord and Tenant Board.'],
  ['RTA|section:12', 'Despite section 2, a notice is valid if given in writing.'],
  ['RTA|section:241', 'This section is not yet in force.'],
])

const docB = doc('CONDO', [
  ['CONDO|section:1', 'In this Act, "corporation" means a condominium corporation.'],
  ['CONDO|section:7', 'Despite section 1, a board may pass by-laws.'],
])

const documents = [docA, docB] as const

// --- prompt versions: the four passes the build requires ---------------------

const promptVersions: Readonly<Record<string, string>> = {
  'cross-references': 'xref-v1',
  definitions: 'def-v1',
  'amendment-flags': 'amend-v1',
  'situating-context': 'situ-v1',
}

const config: PipelineConfig = {
  chunkerId: citableUnitChunker.id,
  enrichmentModel: 'fake-claude-0',
  promptVersions,
}

const manifestHash = 'manifest-hash-abc123'

// --- scripted fake responder: routes tree passes vs the chunk pass -----------

/** Which tree pass a request is for, recovered from its system-prompt marker. */
const treePassOf = (request: ClaudeRequest): TreePass | undefined =>
  TREE_PASSES.find((pass) => request.system.includes(`pass:${pass}`))

/** Extract the requested chunk ids from a situating-context request's user content. */
const parseRequestedChunkIds = (user: string): string[] => {
  const payload = JSON.parse(user) as { chunks?: Array<{ id: string }> }
  return (payload.chunks ?? []).map((chunk) => chunk.id)
}

/**
 * Every pathKey the document tree addresses (the skeleton the slice's anti-
 * hallucination guard checks against — it includes the root documentId node).
 */
const knownPaths = (parsed: ParsedDocument): string[] => {
  const keys: string[] = []
  walkTree(parsed.tree, (_node, path) => keys.push(pathKey(path)))
  return keys
}

/** The text-bearing provision paths (skeleton minus the structural root node). */
const provisionPaths = (skeleton: readonly string[]): string[] =>
  skeleton.filter((key) => key.includes('|'))

/**
 * A scripted responder playing Claude for ALL four passes, over ANY of the
 * synthetic documents. Tree passes route on the `pass:<name>` marker and answer
 * with artifacts whose every path already exists in the requested document; the
 * chunk pass answers one non-empty context per requested chunk id. Because the
 * user content carries the document skeleton, the responder picks real paths out
 * of it rather than inventing them — honouring AC4's anti-hallucination guard.
 */
const buildResponder = (): FakeResponder => {
  return (request) => {
    const treePass = treePassOf(request)
    if (treePass !== undefined) {
      const payload = JSON.parse(request.user) as { skeleton: string[] }
      // Only reference real provisions (text-bearing paths), never the root node.
      const paths = provisionPaths(payload.skeleton)
      switch (treePass) {
        case 'cross-references':
          // One edge between the first two real paths, when present.
          return JSON.stringify({
            edges: paths.length >= 2 ? [{ from: paths[1]!, to: paths[0]!, kind: 'despite' }] : [],
          })
        case 'definitions':
          return JSON.stringify({
            definitions: paths.length >= 1 ? { Term: paths[0]! } : {},
          })
        case 'amendment-flags':
          return JSON.stringify({
            flags:
              paths.length >= 1
                ? [{ path: paths[paths.length - 1]!, note: 'not yet in force' }]
                : [],
          })
      }
    }
    // Otherwise it is the situating-context (chunk) pass.
    return JSON.stringify(
      parseRequestedChunkIds(request.user).map((id) => ({
        id,
        context: `Situating context for ${id}.`,
      })),
    )
  }
}

/** A fresh pair of per-stage caches for a build. */
const newCaches = (): {
  tree: EnrichmentCache<string>
  chunk: EnrichmentCache<string>
} => ({
  tree: createMemoryCache<string>(),
  chunk: createMemoryCache<string>(),
})

/** A toy whole-document chunker with a DIFFERENT id (for AC2). */
const wholeDocChunker: Chunker = {
  id: 'whole-doc',
  chunk(parsed) {
    const text = [...parsed.text.values()].join('\n\n')
    if (text === '') return []
    return [
      {
        id: `${this.id}:${parsed.tree.documentId}`,
        citablePathKey: parsed.tree.documentId,
        text,
      },
    ]
  },
}

// =============================================================================
// AC1
// =============================================================================

describe('AC1 "Re-running with unchanged inputs yields 100% cache hits"', () => {
  it('a second run over the same caches makes ZERO new client calls', async () => {
    const caches = newCaches()
    const first = fakeClaudeClient({ responder: buildResponder() })
    await runEnrichmentBuild({
      documents,
      manifestHash,
      config,
      client: first,
      chunker: citableUnitChunker,
      caches,
    })
    const callsAfterFirst = first.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    caches.tree.resetStats()
    caches.chunk.resetStats()
    const second = fakeClaudeClient({ responder: buildResponder() })
    await runEnrichmentBuild({
      documents,
      manifestHash,
      config,
      client: second,
      chunker: citableUnitChunker,
      caches,
    })

    expect(second.calls.length).toBe(0)
  })

  it('the second run is all hits and zero misses across both stage caches', async () => {
    const caches = newCaches()
    await runEnrichmentBuild({
      documents,
      manifestHash,
      config,
      client: fakeClaudeClient({ responder: buildResponder() }),
      chunker: citableUnitChunker,
      caches,
    })

    caches.tree.resetStats()
    caches.chunk.resetStats()
    await runEnrichmentBuild({
      documents,
      manifestHash,
      config,
      client: fakeClaudeClient({ responder: buildResponder() }),
      chunker: citableUnitChunker,
      caches,
    })

    expect(caches.tree.stats().misses).toBe(0)
    expect(caches.tree.stats().hits).toBeGreaterThan(0)
    expect(caches.chunk.stats().misses).toBe(0)
    expect(caches.chunk.stats().hits).toBeGreaterThan(0)
  })

  it('the rebuilt artifacts are identical to the first run', async () => {
    const caches = newCaches()
    const first = await runEnrichmentBuild({
      documents,
      manifestHash,
      config,
      client: fakeClaudeClient({ responder: buildResponder() }),
      chunker: citableUnitChunker,
      caches,
    })
    const second = await runEnrichmentBuild({
      documents,
      manifestHash,
      config,
      client: fakeClaudeClient({ responder: buildResponder() }),
      chunker: citableUnitChunker,
      caches,
    })

    expect(second.trees).toEqual(first.trees)
    expect(second.chunks).toEqual(first.chunks)
    expect(second.metadata.buildHash).toBe(first.metadata.buildHash)
  })
})

// =============================================================================
// AC2
// =============================================================================

describe('model change over persisted caches (Codex P1: no stale cross-model hits)', () => {
  it('changing only the enrichment model re-runs every producer pass instead of serving the old model from cache', async () => {
    const caches = newCaches()
    await runEnrichmentBuild({
      documents,
      manifestHash,
      config,
      client: fakeClaudeClient({ model: config.enrichmentModel, responder: buildResponder() }),
      chunker: citableUnitChunker,
      caches,
    })

    const swappedConfig: PipelineConfig = { ...config, enrichmentModel: 'fake-claude-1' }
    const swappedClient = fakeClaudeClient({
      model: swappedConfig.enrichmentModel,
      responder: buildResponder(),
    })
    const rebuilt = await runEnrichmentBuild({
      documents,
      manifestHash,
      config: swappedConfig,
      client: swappedClient,
      chunker: citableUnitChunker,
      caches,
    })

    // Every artifact labeled with the new model must have been produced by it:
    // 3 tree passes + 1 chunk pass per document, all fresh.
    expect(swappedClient.calls.length).toBe(documents.length * 4)
    for (const tree of rebuilt.trees) expect(tree.model).toBe('fake-claude-1')
    for (const chunks of rebuilt.chunks) expect(chunks.model).toBe('fake-claude-1')
  })
})

describe('AC2 "Changing the chunker invalidates chunk-level enrichment only; tree-level survives"', () => {
  it('a chunker swap makes fresh chunk-level calls but ZERO tree-level calls', async () => {
    const caches = newCaches()
    await runEnrichmentBuild({
      documents,
      manifestHash,
      config,
      client: fakeClaudeClient({ responder: buildResponder() }),
      chunker: citableUnitChunker,
      caches,
    })

    // A chunker swap is a config change: mint a config carrying the new id.
    const swappedConfig: PipelineConfig = { ...config, chunkerId: wholeDocChunker.id }
    caches.tree.resetStats()
    caches.chunk.resetStats()
    const swapped = fakeClaudeClient({ responder: buildResponder() })
    await runEnrichmentBuild({
      documents,
      manifestHash,
      config: swappedConfig,
      client: swapped,
      chunker: wholeDocChunker,
      caches,
    })

    // Tree-level: all hits, no misses, so no tree pass ever hit the client.
    expect(caches.tree.stats().misses).toBe(0)
    expect(caches.tree.stats().hits).toBeGreaterThan(0)
    // Chunk-level: the swap re-derived chunk ids/hashes -> fresh misses & calls.
    expect(caches.chunk.stats().misses).toBeGreaterThan(0)
    expect(swapped.calls.length).toBeGreaterThan(0)
    // Every client call the swap made was a chunk-pass call (no tree pass):
    // it carries no `pass:<tree-pass>` marker and is a situating-context request.
    for (const call of swapped.calls) {
      expect(treePassOf(call)).toBeUndefined()
      expect(call.system.toLowerCase()).toContain('situating context')
    }
  })

  it('the tree hash of every document is identical across both builds', async () => {
    const caches = newCaches()
    const first = await runEnrichmentBuild({
      documents,
      manifestHash,
      config,
      client: fakeClaudeClient({ responder: buildResponder() }),
      chunker: citableUnitChunker,
      caches,
    })

    const swappedConfig: PipelineConfig = { ...config, chunkerId: wholeDocChunker.id }
    const second = await runEnrichmentBuild({
      documents,
      manifestHash,
      config: swappedConfig,
      client: fakeClaudeClient({ responder: buildResponder() }),
      chunker: wholeDocChunker,
      caches,
    })

    const firstHashes = first.trees.map((t) => t.treeHash)
    const secondHashes = second.trees.map((t) => t.treeHash)
    expect(secondHashes).toEqual(firstHashes)
    // And they equal the hashes recomputed straight from the source documents.
    expect(firstHashes).toEqual(documents.map(hashTree))
  })
})

// =============================================================================
// AC3
// =============================================================================

describe('AC3 "Build hash changes iff manifest or pipeline config changes; enrichment model recorded in build metadata"', () => {
  const build = async (input: { manifestHash: string; config: PipelineConfig }) =>
    runEnrichmentBuild({
      documents,
      manifestHash: input.manifestHash,
      config: input.config,
      client: fakeClaudeClient({
        model: input.config.enrichmentModel,
        responder: buildResponder(),
      }),
      chunker: input.config.chunkerId === wholeDocChunker.id ? wholeDocChunker : citableUnitChunker,
      caches: newCaches(),
    })

  it('identical inputs yield an identical build hash', async () => {
    const a = await build({ manifestHash, config })
    const b = await build({ manifestHash, config })
    expect(b.metadata.buildHash).toBe(a.metadata.buildHash)
  })

  it('changing the manifest hash changes the build hash', async () => {
    const base = await build({ manifestHash, config })
    const changed = await build({ manifestHash: 'a-different-manifest', config })
    expect(changed.metadata.buildHash).not.toBe(base.metadata.buildHash)
  })

  it('changing the chunker id changes the build hash', async () => {
    const base = await build({ manifestHash, config })
    const changed = await build({
      manifestHash,
      config: { ...config, chunkerId: wholeDocChunker.id },
    })
    expect(changed.metadata.buildHash).not.toBe(base.metadata.buildHash)
  })

  it('changing the enrichment model changes the build hash', async () => {
    const base = await build({ manifestHash, config })
    const changed = await build({
      manifestHash,
      config: { ...config, enrichmentModel: 'fake-claude-1' },
    })
    expect(changed.metadata.buildHash).not.toBe(base.metadata.buildHash)
  })

  it('changing any single prompt version changes the build hash', async () => {
    const base = await build({ manifestHash, config })
    const changed = await build({
      manifestHash,
      config: {
        ...config,
        promptVersions: { ...promptVersions, 'situating-context': 'situ-v2' },
      },
    })
    expect(changed.metadata.buildHash).not.toBe(base.metadata.buildHash)
  })

  it('records the enrichment model in the build metadata', async () => {
    const result = await build({ manifestHash, config })
    expect(result.metadata.enrichmentModel).toBe(config.enrichmentModel)
    expect(result.metadata.manifestHash).toBe(manifestHash)
    expect(result.metadata.pipelineConfig).toEqual(config)
  })
})

// =============================================================================
// AC4
// =============================================================================

describe('AC4 "No LLM ever re-authors source text"', () => {
  it('hashTree(parsed) is identical before and after the whole build for every document', async () => {
    const before = documents.map(hashTree)
    await runEnrichmentBuild({
      documents,
      manifestHash,
      config,
      client: fakeClaudeClient({ responder: buildResponder() }),
      chunker: citableUnitChunker,
      caches: newCaches(),
    })
    const after = documents.map(hashTree)
    expect(after).toEqual(before)
  })

  it('every situated chunk carries its chunker output text byte-identical', async () => {
    const result = await runEnrichmentBuild({
      documents,
      manifestHash,
      config,
      client: fakeClaudeClient({ responder: buildResponder() }),
      chunker: citableUnitChunker,
      caches: newCaches(),
    })

    for (const enrichment of result.chunks) {
      const sourceDoc = documents.find((d) => d.tree.documentId === enrichment.documentId)!
      const originalChunks = citableUnitChunker.chunk(sourceDoc)
      expect(enrichment.chunks.map((c) => c.chunk.text)).toEqual(originalChunks.map((c) => c.text))
      // The situating context lives beside the text, never replaces it.
      for (const situated of enrichment.chunks) {
        expect(situated.situatingContext).not.toBe(situated.chunk.text)
      }
    }
  })

  it('every artifact pathKey already exists in its source document', async () => {
    const result = await runEnrichmentBuild({
      documents,
      manifestHash,
      config,
      client: fakeClaudeClient({ responder: buildResponder() }),
      chunker: citableUnitChunker,
      caches: newCaches(),
    })

    for (const tree of result.trees) {
      const sourceDoc = documents.find((d) => d.tree.documentId === tree.documentId)!
      const known = new Set(knownPaths(sourceDoc))
      for (const edge of tree.crossReferences) {
        expect(known.has(edge.from)).toBe(true)
        expect(known.has(edge.to)).toBe(true)
      }
      for (const path of Object.values(tree.definitions)) {
        expect(known.has(path)).toBe(true)
      }
      for (const flag of tree.amendmentFlags) {
        expect(known.has(flag.path)).toBe(true)
      }
    }
  })

  it('a hallucinating responder that invents a citable path makes the build THROW', async () => {
    const hallucinating: FakeResponder = (request) => {
      if (treePassOf(request) === 'cross-references') {
        return JSON.stringify({
          edges: [{ from: 'GHOST|section:999', to: 'GHOST|section:998', kind: 'despite' }],
        })
      }
      return buildResponder()(request)
    }
    await expect(
      runEnrichmentBuild({
        documents,
        manifestHash,
        config,
        client: fakeClaudeClient({ responder: hallucinating }),
        chunker: citableUnitChunker,
        caches: newCaches(),
      }),
    ).rejects.toThrow(/GHOST\|section:999/)
  })
})

// =============================================================================
// AC5
// =============================================================================

describe('AC5 "Flags flip at consumers without touching producers"', () => {
  it('embeddableText differs under chunkContext on vs off with ZERO additional client calls', async () => {
    const client = fakeClaudeClient({ responder: buildResponder() })
    const result = await runEnrichmentBuild({
      documents,
      manifestHash,
      config,
      client,
      chunker: citableUnitChunker,
      caches: newCaches(),
    })
    const callsAfterBuild = client.calls.length

    const situated = result.chunks[0]!.chunks[0]!

    const off = embeddableText(situated.chunk, situated.situatingContext, DEFAULT_CONSUMER_FLAGS)
    const on = embeddableText(situated.chunk, situated.situatingContext, {
      ...DEFAULT_CONSUMER_FLAGS,
      chunkContext: true,
    })

    expect(off).toBe(situated.chunk.text)
    expect(on).not.toBe(off)
    expect(on).toContain(situated.situatingContext)
    expect(on).toContain(situated.chunk.text)

    // Flipping the flag never touched a producer: no new client calls.
    expect(client.calls.length).toBe(callsAfterBuild)
  })

  it('selectQueryTimeArtifacts differs under flags on vs off with ZERO additional client calls', async () => {
    const client = fakeClaudeClient({ responder: buildResponder() })
    const result = await runEnrichmentBuild({
      documents,
      manifestHash,
      config,
      client,
      chunker: citableUnitChunker,
      caches: newCaches(),
    })
    const callsAfterBuild = client.calls.length

    const tree = result.trees[0]!
    const artifacts = {
      crossReferences: tree.crossReferences,
      definitions: tree.definitions,
    }

    const off = selectQueryTimeArtifacts(artifacts, DEFAULT_CONSUMER_FLAGS)
    expect(off.crossReferences).toBeUndefined()
    expect(off.definitions).toBeUndefined()

    const on = selectQueryTimeArtifacts(artifacts, {
      xrefExpansion: true,
      definitionsInPrompt: true,
      chunkContext: false,
    })
    expect(on.crossReferences).toBe(tree.crossReferences)
    expect(on.definitions).toBe(tree.definitions)

    expect(client.calls.length).toBe(callsAfterBuild)
  })
})

// =============================================================================
// tree -> chunk dataflow (CONTEXT.md line 134)
// =============================================================================

describe('tree-level enrichment feeds chunk-level enrichment (CONTEXT.md line 134)', () => {
  it('the chunk-pass user payload embeds the definitions the TREE pass returned for that document', async () => {
    // Capture every situating-context (chunk-pass) request's user payload.
    const chunkUserPayloads: string[] = []
    const responder = buildResponder()
    const recordingResponder: FakeResponder = (request) => {
      if (treePassOf(request) === undefined) {
        chunkUserPayloads.push(request.user)
      }
      return responder(request)
    }

    await runEnrichmentBuild({
      documents,
      manifestHash,
      config,
      client: fakeClaudeClient({ responder: recordingResponder }),
      chunker: citableUnitChunker,
      caches: newCaches(),
    })

    // The responder defines `{ Term: <first provision path> }` per document. For
    // docA that path is RTA|section:2; for docB, CONDO|section:1. The chunk pass
    // could only carry these if the tree pass ran FIRST and was consumed.
    const parsedPayloads = chunkUserPayloads.map(
      (user) =>
        JSON.parse(user) as {
          documentId: string
          definitions: Record<string, string>
          crossReferences: Array<{ from: string; to: string; kind: string }>
        },
    )

    const docAPayload = parsedPayloads.find((p) => p.documentId === 'RTA')!
    const docBPayload = parsedPayloads.find((p) => p.documentId === 'CONDO')!

    expect(docAPayload.definitions).toEqual({ Term: 'RTA|section:2' })
    expect(docBPayload.definitions).toEqual({ Term: 'CONDO|section:1' })
    // And the cross-references the tree pass recovered ride along too.
    expect(docAPayload.crossReferences).toEqual([
      { from: 'RTA|section:12', to: 'RTA|section:2', kind: 'despite' },
    ])
  })
})

// =============================================================================
// coherence guards
// =============================================================================

describe('runEnrichmentBuild — coherence guards', () => {
  it('throws when the chunker id does not match the config chunker id', async () => {
    await expect(
      runEnrichmentBuild({
        documents,
        manifestHash,
        config,
        client: fakeClaudeClient({ responder: buildResponder() }),
        chunker: wholeDocChunker,
        caches: newCaches(),
      }),
    ).rejects.toThrow(/chunker/i)
  })

  it('throws when the client model does not match the config enrichment model', async () => {
    await expect(
      runEnrichmentBuild({
        documents,
        manifestHash,
        config,
        client: fakeClaudeClient({ model: 'some-other-model', responder: buildResponder() }),
        chunker: citableUnitChunker,
        caches: newCaches(),
      }),
    ).rejects.toThrow(/model/i)
  })

  it('throws descriptively when a required prompt-version entry is missing', async () => {
    const withoutSituating = Object.fromEntries(
      Object.entries(promptVersions).filter(([pass]) => pass !== 'situating-context'),
    )
    const badConfig: PipelineConfig = { ...config, promptVersions: withoutSituating }
    await expect(
      runEnrichmentBuild({
        documents,
        manifestHash,
        config: badConfig,
        client: fakeClaudeClient({ responder: buildResponder() }),
        chunker: citableUnitChunker,
        caches: newCaches(),
      }),
    ).rejects.toThrow(/situating-context/)
  })
})
