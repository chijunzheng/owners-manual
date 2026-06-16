import { describe, expect, it } from 'vitest'

import {
  AGENT_QUERY_FLAGS_OFF,
  RERANK_PROVIDERS,
  agentQueryFlagsSchema,
  parseAgentQueryFlags,
  resolveAgentQueryFlags,
  type AgentQueryFlags,
} from './agent-query-flags.js'

// The flag set is the heart of #16's ablation contract: every component lands
// behind a config flag, every off-state is a DEFINED, DOCUMENTED fallback, and a
// test pins that off-state. These tests are that pin.

describe('agent query flags — the ablation surface', () => {
  it('defaults every component OFF (the all-off baseline = the naive query path)', () => {
    expect(AGENT_QUERY_FLAGS_OFF.xrefExpansion).toBe(false)
    expect(AGENT_QUERY_FLAGS_OFF.definitionsInPrompt).toBe(false)
    expect(AGENT_QUERY_FLAGS_OFF.queryReformulation).toBe(false)
    expect(AGENT_QUERY_FLAGS_OFF.rerank).toBe(false)
  })

  it('defaults the rerank provider to authority (deterministic, no live call)', () => {
    // The provider only matters when `rerank` is on; off-state still names a
    // deterministic default so a flag set is never ambiguous.
    expect(AGENT_QUERY_FLAGS_OFF.rerankProvider).toBe('authority')
  })

  it('is deeply frozen so the all-off baseline can never drift at runtime', () => {
    expect(Object.isFrozen(AGENT_QUERY_FLAGS_OFF)).toBe(true)
  })

  it('exposes the closed set of rerank providers (authority / llm / cohere)', () => {
    expect([...RERANK_PROVIDERS]).toEqual(['authority', 'llm', 'cohere'])
  })

  it('parses an empty object to the all-off default (every field optional)', () => {
    expect(parseAgentQueryFlags({})).toEqual(AGENT_QUERY_FLAGS_OFF)
  })

  it('parses a partial flag set, filling omitted fields with their off-state', () => {
    const flags = parseAgentQueryFlags({ xrefExpansion: true, rerank: true })
    expect(flags.xrefExpansion).toBe(true)
    expect(flags.rerank).toBe(true)
    expect(flags.definitionsInPrompt).toBe(false)
    expect(flags.queryReformulation).toBe(false)
    expect(flags.rerankProvider).toBe('authority')
  })

  it('accepts each rerank provider choice for the A/B', () => {
    for (const provider of RERANK_PROVIDERS) {
      expect(parseAgentQueryFlags({ rerank: true, rerankProvider: provider }).rerankProvider).toBe(
        provider,
      )
    }
  })

  it('REJECTS an unknown flag key (a typo must fail loudly, not silently off)', () => {
    expect(() => parseAgentQueryFlags({ xref_expansion: true })).toThrow()
  })

  it('REJECTS an unknown rerank provider', () => {
    expect(() => parseAgentQueryFlags({ rerankProvider: 'voyage' })).toThrow()
  })

  it('round-trips a fully-on flag set through the schema unchanged', () => {
    const on: AgentQueryFlags = {
      xrefExpansion: true,
      definitionsInPrompt: true,
      queryReformulation: true,
      rerank: true,
      rerankProvider: 'cohere',
    }
    expect(agentQueryFlagsSchema.parse(on)).toEqual(on)
  })
})

describe('resolveAgentQueryFlags — query-time env resolution (same build, no re-index)', () => {
  it('defaults to all-off when no flag env vars are set', () => {
    expect(resolveAgentQueryFlags({})).toEqual(AGENT_QUERY_FLAGS_OFF)
  })

  it('reads each boolean flag from its OWNERS_MANUAL_* env var ("1" = on)', () => {
    const flags = resolveAgentQueryFlags({
      OWNERS_MANUAL_XREF_EXPANSION: '1',
      OWNERS_MANUAL_DEFINITIONS_IN_PROMPT: '1',
      OWNERS_MANUAL_QUERY_REFORMULATION: '1',
      OWNERS_MANUAL_RERANK: '1',
    })
    expect(flags.xrefExpansion).toBe(true)
    expect(flags.definitionsInPrompt).toBe(true)
    expect(flags.queryReformulation).toBe(true)
    expect(flags.rerank).toBe(true)
  })

  it('treats any value other than "1"/"true" as off (a flag is off unless explicitly on)', () => {
    expect(resolveAgentQueryFlags({ OWNERS_MANUAL_RERANK: '0' }).rerank).toBe(false)
    expect(resolveAgentQueryFlags({ OWNERS_MANUAL_RERANK: 'yes' }).rerank).toBe(false)
  })

  it('reads the rerank provider from OWNERS_MANUAL_RERANK_PROVIDER', () => {
    expect(
      resolveAgentQueryFlags({ OWNERS_MANUAL_RERANK: '1', OWNERS_MANUAL_RERANK_PROVIDER: 'cohere' })
        .rerankProvider,
    ).toBe('cohere')
  })

  it('throws on an unknown rerank provider env value (fails loud at the boundary)', () => {
    expect(() => resolveAgentQueryFlags({ OWNERS_MANUAL_RERANK_PROVIDER: 'voyage' })).toThrow()
  })
})
