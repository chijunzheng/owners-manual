import { describe, expect, it } from 'vitest'

import { AGENT_QUERY_FLAGS_OFF, type AgentQueryFlags } from './agent-query-flags.js'
import { candidate, REPAIR_CANDIDATE, VOID_CLAUSE_CANDIDATE } from './agent-fixtures.js'
import {
  AGENT_TOP_K_DEFAULT,
  reformulateNode,
  rerankNode,
  retrieveNode,
  routeAfterRetrieve,
  type AgentStatePatch,
} from './agent-nodes.js'
import { type AgentEnrichmentAccess, type AgentState } from './agent-types.js'
import { AGENT_LOOP_CAPS } from './agent-types.js'
import { authorityRerank, scriptedRerank } from './rerank.js'
import { type HybridCandidate } from './hybrid-retrieve.js'

// #16 wires three FLAGGED components into the graph nodes. Each test pins both the
// on-behaviour AND the documented off-state fallback, driven through fakes — never
// a live call. Flags are graph-construction deps closed over in the node bindings;
// these tests call the node functions directly with explicit flags.

/** Build an AgentState with overrides over the answer-path defaults. */
function state(overrides: Partial<AgentState> = {}): AgentState {
  return {
    question: 'who repairs the unit?',
    candidates: [],
    definitionAttachments: [],
    reformulations: 0,
    criticReretrievals: 0,
    degraded: false,
    ...overrides,
  }
}

const flags = (over: Partial<AgentQueryFlags> = {}): AgentQueryFlags => ({
  ...AGENT_QUERY_FLAGS_OFF,
  ...over,
})

/** An enrichment-access seam with a fixed xref graph + definitions + corpus. */
function enrichment(corpus: readonly HybridCandidate[]): AgentEnrichmentAccess {
  const byKey = new Map(corpus.map((c) => [c.citablePathKey, c]))
  return {
    crossReferencesFor: () => [
      {
        from: REPAIR_CANDIDATE.citablePathKey,
        to: 'rta-2006|part:III|section:30',
        kind: 'referenced-by',
      },
    ],
    definitionsFor: () => ({ 'good state of repair': 'rta-2006|part:I|section:2|clause:def' }),
    lookup: (key: string) => byKey.get(key),
  }
}

const XREF_TARGET = candidate(
  'rta-2006|part:III|section:30',
  'Despite section 20, the tenant may apply to the Board.',
  0.4,
)

// --- retrieve node: graph-expansion flag -----------------------------------

describe('retrieveNode — xrefExpansion flag', () => {
  const retrieve = async () => [REPAIR_CANDIDATE]

  it('OFF (fallback): returns exactly hybrid retrieval, no expansion', async () => {
    const patch = await retrieveNode(state(), retrieve, AGENT_TOP_K_DEFAULT, {
      flags: AGENT_QUERY_FLAGS_OFF,
      enrichment: enrichment([REPAIR_CANDIDATE, XREF_TARGET]),
    })
    expect(patch.candidates).toHaveLength(1)
    expect(patch.candidates![0]!.citablePathKey).toBe(REPAIR_CANDIDATE.citablePathKey)
  })

  it('ON: pulls in the one-hop xref neighbour tagged graph-expansion', async () => {
    const patch = await retrieveNode(state(), retrieve, AGENT_TOP_K_DEFAULT, {
      flags: flags({ xrefExpansion: true }),
      enrichment: enrichment([REPAIR_CANDIDATE, XREF_TARGET]),
    })
    const expanded = patch.candidates!.find((c) => c.citablePathKey === XREF_TARGET.citablePathKey)
    expect(expanded).toBeDefined()
    expect(expanded!.stage).toBe('graph-expansion')
  })

  it('works with no enrichment access (back-compat: behaves as OFF)', async () => {
    const patch = await retrieveNode(state(), retrieve)
    expect(patch.candidates).toHaveLength(1)
  })
})

// --- rerank node: rerank flag + injected provider --------------------------

describe('rerankNode — rerank flag + injected seam', () => {
  it('OFF (fallback): preserves the raw RRF/similarity order, no authority weighting', () => {
    // void clause (contract, score 0.84) is ranked ABOVE repair (act, 0.91) in the
    // input; with rerank OFF the input order is preserved (no authority sort).
    const input = [VOID_CLAUSE_CANDIDATE, REPAIR_CANDIDATE]
    const patch = rerankNode(state({ candidates: input }), {
      flags: AGENT_QUERY_FLAGS_OFF,
      rerank: authorityRerank,
    })
    // The off path is SYNCHRONOUS by design — it never awaits the provider it
    // will not call. Asserting that here doubles as the type narrowing.
    expect(patch).not.toBeInstanceOf(Promise)
    const synced = patch as AgentStatePatch
    expect(synced.candidates![0]!.citablePathKey).toBe(VOID_CLAUSE_CANDIDATE.citablePathKey)
  })

  it('OFF (fallback): does NOT tag candidates rerank-survivor', () => {
    const patch = rerankNode(state({ candidates: [REPAIR_CANDIDATE] }), {
      flags: AGENT_QUERY_FLAGS_OFF,
      rerank: authorityRerank,
    }) as AgentStatePatch
    expect(patch.candidates![0]!.stages).not.toContain('rerank-survivor')
  })

  it('ON: runs the injected reranker (authority outranks contract) and tags survivors', async () => {
    const patch = await Promise.resolve(
      rerankNode(state({ candidates: [VOID_CLAUSE_CANDIDATE, REPAIR_CANDIDATE] }), {
        flags: flags({ rerank: true }),
        rerank: authorityRerank,
      }),
    )
    expect(patch.candidates![0]!.documentId).toBe('rta-2006')
    expect(patch.candidates![0]!.stages).toContain('rerank-survivor')
  })

  it('ON: a scripted (Cohere/LLM-shaped) provider drives the order', async () => {
    const patch = await Promise.resolve(
      rerankNode(state({ candidates: [REPAIR_CANDIDATE, VOID_CLAUSE_CANDIDATE] }), {
        flags: flags({ rerank: true, rerankProvider: 'cohere' }),
        rerank: scriptedRerank([
          VOID_CLAUSE_CANDIDATE.citablePathKey,
          REPAIR_CANDIDATE.citablePathKey,
        ]),
      }),
    )
    expect(patch.candidates!.map((c) => c.citablePathKey)).toEqual([
      VOID_CLAUSE_CANDIDATE.citablePathKey,
      REPAIR_CANDIDATE.citablePathKey,
    ])
  })
})

// --- reformulation edge: bounded, flagged ----------------------------------

describe('reformulateNode / routeAfterRetrieve — bounded reformulation', () => {
  it('OFF (fallback): never reformulates — routes straight to rerank', () => {
    const route = routeAfterRetrieve(
      state({ candidates: [REPAIR_CANDIDATE] }),
      AGENT_QUERY_FLAGS_OFF,
    )
    expect(route).toBe('rerank')
  })

  it('OFF: routes to rerank even when the candidate set is EMPTY (single pass)', () => {
    const route = routeAfterRetrieve(state({ candidates: [] }), AGENT_QUERY_FLAGS_OFF)
    expect(route).toBe('rerank')
  })

  it('ON + thin candidates + under cap: routes to reformulate', () => {
    const route = routeAfterRetrieve(
      state({ candidates: [], reformulations: 0 }),
      flags({ queryReformulation: true }),
    )
    expect(route).toBe('reformulate')
  })

  it('ON + candidates already present: does NOT reformulate (only rescues thin sets)', () => {
    const route = routeAfterRetrieve(
      state({ candidates: [REPAIR_CANDIDATE], reformulations: 0 }),
      flags({ queryReformulation: true }),
    )
    expect(route).toBe('rerank')
  })

  it('ON + thin + AT the reformulation cap: routes to rerank (bounded, never an open loop)', () => {
    const route = routeAfterRetrieve(
      state({ candidates: [], reformulations: AGENT_LOOP_CAPS.maxReformulations }),
      flags({ queryReformulation: true }),
    )
    expect(route).toBe('rerank')
  })

  it('reformulateNode bumps the reformulations counter by one', () => {
    const patch = reformulateNode(state({ reformulations: 0 }))
    expect(patch.reformulations).toBe(1)
  })

  it('reformulateNode never exceeds the cap in a single bump from the cap-1 state', () => {
    const patch = reformulateNode(state({ reformulations: AGENT_LOOP_CAPS.maxReformulations - 1 }))
    expect(patch.reformulations).toBe(AGENT_LOOP_CAPS.maxReformulations)
  })
})
