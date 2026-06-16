import { describe, expect, it } from 'vitest'

import { candidate, REPAIR_CANDIDATE, VOID_CLAUSE_CANDIDATE } from './agent-fixtures.js'
import { authorityRerank, scriptedRerank, tagRerankSurvivors, type AgentRerank } from './rerank.js'
import { type HybridCandidate } from './hybrid-retrieve.js'

// The rerank seam (#16): authority-weighted reranking with Cohere-vs-LLM
// selectable behind a flag. The provider is an INJECTED seam (mirroring AgentModel
// / AgentRetrieve) so unit tests drive a SCRIPTED FAKE — never a live Cohere/Vertex
// call. Survivors carry the `rerank-survivor` provenance tag so the dashboard can
// credit the cites the reranker promoted into the answerable window.

describe('authorityRerank — the deterministic, provider-free reranker', () => {
  it('orders a higher-authority candidate before a lower-authority one', async () => {
    const ranked = await authorityRerank({
      question: 'who pays for damage?',
      candidates: [VOID_CLAUSE_CANDIDATE, REPAIR_CANDIDATE],
    })
    // rta-2006 is an Act; fixture-lease is a contract — the Act outranks it.
    expect(ranked[0]!.documentId).toBe('rta-2006')
  })

  it('breaks ties within an authority level by fused score', async () => {
    const a = candidate('rta-2006|section:10', 'a', 0.5)
    const b = candidate('rta-2006|section:11', 'b', 0.8)
    const ranked = await authorityRerank({ question: 'q', candidates: [a, b] })
    expect(ranked[0]!.citablePathKey).toBe('rta-2006|section:11')
  })

  it('tags every survivor it returns with rerank-survivor provenance', async () => {
    const ranked = await authorityRerank({
      question: 'q',
      candidates: [VOID_CLAUSE_CANDIDATE, REPAIR_CANDIDATE],
    })
    for (const c of ranked) {
      expect(c.stages).toContain('rerank-survivor')
    }
  })
})

describe('tagRerankSurvivors — provenance for promoted candidates', () => {
  it('adds rerank-survivor to each candidate without dropping prior stages', () => {
    const tagged = tagRerankSurvivors([REPAIR_CANDIDATE])
    expect(tagged[0]!.stages).toContain('rerank-survivor')
    // the original hybrid provenance survives
    expect(tagged[0]!.stages).toContain('vector')
    expect(tagged[0]!.stages).toContain('bm25')
  })

  it('does not duplicate the tag when applied twice (idempotent)', () => {
    const once = tagRerankSurvivors([REPAIR_CANDIDATE])
    const twice = tagRerankSurvivors(once)
    const count = twice[0]!.stages.filter((s) => s === 'rerank-survivor').length
    expect(count).toBe(1)
  })

  it('keeps stages sorted and deterministic', () => {
    const tagged = tagRerankSurvivors([REPAIR_CANDIDATE])
    expect([...tagged[0]!.stages]).toEqual([...tagged[0]!.stages].sort())
  })
})

describe('scriptedRerank — the test seam for the LLM/Cohere A/B', () => {
  it('returns candidates in the scripted path-key order (a fake provider ranking)', async () => {
    const rerank: AgentRerank = scriptedRerank([
      VOID_CLAUSE_CANDIDATE.citablePathKey,
      REPAIR_CANDIDATE.citablePathKey,
    ])
    const ranked = await rerank({
      question: 'q',
      candidates: [REPAIR_CANDIDATE, VOID_CLAUSE_CANDIDATE],
    })
    expect(ranked.map((c) => c.citablePathKey)).toEqual([
      VOID_CLAUSE_CANDIDATE.citablePathKey,
      REPAIR_CANDIDATE.citablePathKey,
    ])
  })

  it('tags scripted survivors with rerank-survivor too (provider-agnostic provenance)', async () => {
    const rerank = scriptedRerank([REPAIR_CANDIDATE.citablePathKey])
    const ranked = await rerank({ question: 'q', candidates: [REPAIR_CANDIDATE] })
    expect(ranked[0]!.stages).toContain('rerank-survivor')
  })

  it('appends any candidate the script omitted, after the ranked ones (never drops a candidate)', async () => {
    // A reranker that scores a subset must not silently lose the rest — the
    // unranked tail keeps its retrieval order so no retrieved cite vanishes.
    const rerank = scriptedRerank([VOID_CLAUSE_CANDIDATE.citablePathKey])
    const extra = candidate('rta-2006|section:99', 'x', 0.2)
    const ranked = (await rerank({
      question: 'q',
      candidates: [REPAIR_CANDIDATE, VOID_CLAUSE_CANDIDATE, extra],
    })) as readonly HybridCandidate[]
    const keys = ranked.map((c) => c.citablePathKey)
    expect(keys[0]).toBe(VOID_CLAUSE_CANDIDATE.citablePathKey)
    expect(keys).toContain(REPAIR_CANDIDATE.citablePathKey)
    expect(keys).toContain(extra.citablePathKey)
    expect(keys).toHaveLength(3)
  })
})
