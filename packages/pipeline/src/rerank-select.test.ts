import { describe, expect, it } from 'vitest'

import { REPAIR_CANDIDATE, VOID_CLAUSE_CANDIDATE } from './agent-fixtures.js'
import { selectReranker } from './rerank-select.js'
import { authorityRerank, scriptedRerank } from './rerank.js'
import { type AgentRerank } from './agent-types.js'

// The pure provider selector for the rerank A/B: maps the `rerankProvider` flag
// choice to a concrete AgentRerank seam. The live llm/cohere seams are injected
// (never constructed here) so this stays unit-testable with fakes — no live call.

const fakeLlm: AgentRerank = scriptedRerank([REPAIR_CANDIDATE.citablePathKey])
const fakeCohere: AgentRerank = scriptedRerank([VOID_CLAUSE_CANDIDATE.citablePathKey])

describe('selectReranker — the rerank A/B provider switch', () => {
  it('returns the deterministic authority reranker for "authority"', () => {
    const rerank = selectReranker('authority', { llm: fakeLlm, cohere: fakeCohere })
    expect(rerank).toBe(authorityRerank)
  })

  it('returns the injected LLM reranker for "llm"', () => {
    const rerank = selectReranker('llm', { llm: fakeLlm, cohere: fakeCohere })
    expect(rerank).toBe(fakeLlm)
  })

  it('returns the injected Cohere reranker for "cohere"', () => {
    const rerank = selectReranker('cohere', { llm: fakeLlm, cohere: fakeCohere })
    expect(rerank).toBe(fakeCohere)
  })

  it('falls back to the authority reranker when a provider binding is absent', () => {
    // The harness may run with no Cohere/LLM binding wired (e.g. keys unset); the
    // selector degrades to the deterministic authority reranker rather than throw,
    // so a missing key never breaks a run — it just pins the deterministic arm.
    expect(selectReranker('cohere', {})).toBe(authorityRerank)
    expect(selectReranker('llm', {})).toBe(authorityRerank)
  })
})
