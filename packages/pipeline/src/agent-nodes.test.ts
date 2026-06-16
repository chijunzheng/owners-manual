import { describe, expect, it } from 'vitest'

import { AGENT_LOOP_CAPS, type AgentState } from './agent-types.js'
import {
  bumpCriticReretrieval,
  clampEnvelopeToCandidates,
  clampPlan,
  criticNode,
  degradeNode,
  guardNode,
  mergeCandidates,
  plannerNode,
  rerankByAuthority,
  retrieveNode,
  routeAfterCritic,
  routeAfterGuard,
  synthesizeNode,
} from './agent-nodes.js'
import {
  candidate,
  REPAIR_CANDIDATE,
  scriptedModel,
  VOID_CLAUSE_CANDIDATE,
} from './agent-fixtures.js'
import { parseAnswerEnvelope } from './answer-envelope.js'

/** A blank starting state for node-level tests. */
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

describe('guardNode', () => {
  it('passes an in-scope question with no envelope set', async () => {
    const patch = await guardNode(state(), scriptedModel())
    expect(patch.guardDecision?.verdict).toBe('pass')
    expect(patch.envelope).toBeUndefined()
  })

  it('short-circuits a jurisdiction refusal to a refuse-jurisdiction envelope', async () => {
    const model = scriptedModel({
      guard: {
        verdict: 'refuse-jurisdiction',
        injectionDetected: false,
        reason: 'BC, not Ontario',
      },
    })
    const patch = await guardNode(state(), model)
    expect(patch.envelope?.behaviorClass).toBe('refuse-jurisdiction')
    expect(patch.envelope?.claims).toEqual([])
  })

  it('forces out-of-scope on injection even if the verdict said pass', async () => {
    const model = scriptedModel({
      guard: { verdict: 'pass', injectionDetected: true, reason: 'ignore previous instructions' },
    })
    const patch = await guardNode(state(), model)
    expect(patch.envelope?.behaviorClass).toBe('refuse-out-of-scope')
  })

  it('maps an advice verdict to refuse-advice-escalate', async () => {
    const model = scriptedModel({
      guard: {
        verdict: 'refuse-advice-escalate',
        injectionDetected: false,
        reason: 'seek legal counsel',
      },
    })
    const patch = await guardNode(state(), model)
    expect(patch.envelope?.behaviorClass).toBe('refuse-advice-escalate')
  })
})

describe('routeAfterGuard', () => {
  it('routes to plan when no refusal envelope is set', () => {
    expect(routeAfterGuard(state())).toBe('plan')
  })

  it('routes to refused when guard set a refusal envelope', () => {
    const envelope = parseAnswerEnvelope({
      behaviorClass: 'refuse-jurisdiction',
      answer: 'x',
      claims: [],
    })
    expect(routeAfterGuard(state({ envelope }))).toBe('refused')
  })
})

describe('plannerNode / clampPlan', () => {
  it('clamps a plan to the hop cap', () => {
    const hops = Array.from({ length: 9 }, (_v, i) => ({ query: `hop ${i}` }))
    const clamped = clampPlan({ hops, multiHop: true })
    expect(clamped.hops).toHaveLength(AGENT_LOOP_CAPS.maxHops)
  })

  it('never yields an empty hop list', () => {
    const clamped = clampPlan({ hops: [], multiHop: true })
    expect(clamped.hops.length).toBeGreaterThanOrEqual(1)
    expect(clamped.multiHop).toBe(false)
  })

  it('records the planner output (clamped) on the state', async () => {
    const model = scriptedModel({
      plans: [{ hops: [{ query: 'a' }, { query: 'b' }], multiHop: true }],
    })
    const patch = await plannerNode(state(), model)
    expect(patch.plan?.hops).toHaveLength(2)
    expect(patch.plan?.multiHop).toBe(true)
  })
})

describe('retrieveNode / mergeCandidates', () => {
  it('de-duplicates candidates by path key keeping the highest score', () => {
    const low = candidate('rta-2006|section:14', 'x', 0.4)
    const high = candidate('rta-2006|section:14', 'x', 0.9)
    const merged = mergeCandidates([low, high, REPAIR_CANDIDATE])
    expect(merged).toHaveLength(2)
    expect(merged[0]!.score).toBeGreaterThanOrEqual(merged[1]!.score)
    const fourteen = merged.find((c) => c.citablePathKey === 'rta-2006|section:14')
    expect(fourteen?.score).toBe(0.9)
  })

  it('runs every planned hop through the injected retrieve', async () => {
    const seen: string[] = []
    const retrieve = async ({ question }: { question: string }) => {
      seen.push(question)
      return [REPAIR_CANDIDATE]
    }
    const patch = await retrieveNode(
      state({ plan: { hops: [{ query: 'one' }, { query: 'two' }], multiHop: true } }),
      retrieve,
    )
    expect(seen).toEqual(['one', 'two'])
    expect(patch.candidates).toHaveLength(1)
  })

  it('falls back to the question for an empty-query hop', async () => {
    const seen: string[] = []
    const retrieve = async ({ question }: { question: string }) => {
      seen.push(question)
      return []
    }
    await retrieveNode(state({ plan: { hops: [{ query: '' }], multiHop: false } }), retrieve)
    expect(seen).toEqual(['who repairs the unit?'])
  })
})

describe('rerankByAuthority', () => {
  it('orders a higher-authority candidate before a lower-authority one', () => {
    const ranked = rerankByAuthority([VOID_CLAUSE_CANDIDATE, REPAIR_CANDIDATE])
    // rta-2006 is an Act; fixture-lease is a contract — the Act outranks it.
    expect(ranked[0]!.documentId).toBe('rta-2006')
  })

  it('breaks ties within a level by fused score', () => {
    const a = candidate('rta-2006|section:10', 'a', 0.5)
    const b = candidate('rta-2006|section:11', 'b', 0.8)
    const ranked = rerankByAuthority([a, b])
    expect(ranked[0]!.citablePathKey).toBe('rta-2006|section:11')
  })
})

describe('synthesizeNode', () => {
  it('parses a schema-valid envelope and streams tokens', async () => {
    const tokens: string[] = []
    const patch = await synthesizeNode(
      state({ candidates: [REPAIR_CANDIDATE] }),
      scriptedModel({ streamChunks: 4 }),
      (t) => tokens.push(t),
    )
    expect(patch.envelope?.behaviorClass).toBe('answer')
    expect(tokens.length).toBeGreaterThan(1)
    expect(tokens.join('')).toContain('behaviorClass')
  })

  it('clamps cites the model offered that were never retrieved', () => {
    const envelope = parseAnswerEnvelope({
      behaviorClass: 'answer',
      answer: 'a',
      claims: [
        {
          text: 'a',
          cites: [
            {
              documentId: 'rta-2006',
              segments: [{ kind: 'section', label: '999' }],
            },
          ],
        },
      ],
    })
    const clamped = clampEnvelopeToCandidates(envelope, [REPAIR_CANDIDATE])
    expect(clamped.claims[0]!.cites).toEqual([])
  })

  it('keeps a cite that matches a retrieved candidate', () => {
    const envelope = parseAnswerEnvelope({
      behaviorClass: 'answer',
      answer: 'a',
      claims: [{ text: 'a', cites: [REPAIR_CANDIDATE.path] }],
    })
    const clamped = clampEnvelopeToCandidates(envelope, [REPAIR_CANDIDATE])
    expect(clamped.claims[0]!.cites).toHaveLength(1)
  })

  it('propagates a synthesis JSON failure rather than emitting an invalid envelope', async () => {
    const broken = scriptedModel({ synthesisOutputs: ['not json'] })
    await expect(synthesizeNode(state({ candidates: [REPAIR_CANDIDATE] }), broken)).rejects.toThrow(
      /JSON/i,
    )
  })
})

describe('criticNode / routeAfterCritic', () => {
  it('routes to finish when the critic reports grounded', async () => {
    const patch = await criticNode(
      state({
        candidates: [REPAIR_CANDIDATE],
        envelope: parseAnswerEnvelope({ behaviorClass: 'answer', answer: 'a', claims: [] }),
      }),
      scriptedModel(),
    )
    expect(routeAfterCritic(state({ criticDecision: patch.criticDecision }))).toBe('finish')
  })

  it('overrides a model "grounded" verdict when a claim carries no retrieved cite', async () => {
    // The model critic sees only prose + sources, not the claim→cite mapping, so it
    // can pass an envelope whose claim has cites:[] (clampEnvelopeToCandidates can
    // strip a claim's only cite). The deterministic pin-cite gate must catch that.
    const envelope = parseAnswerEnvelope({
      behaviorClass: 'answer',
      answer: 'The landlord pays. Repairs are always free.',
      claims: [
        { text: 'The landlord pays.', cites: [REPAIR_CANDIDATE.path] },
        { text: 'Repairs are always free.', cites: [] },
      ],
    })
    const patch = await criticNode(
      state({ candidates: [REPAIR_CANDIDATE], envelope }),
      scriptedModel({ critiques: [{ grounded: true, ungroundedClaims: [] }] }),
    )
    expect(patch.criticDecision?.grounded).toBe(false)
    expect(patch.criticDecision?.ungroundedClaims).toContain('Repairs are always free.')
    // and the graph must not finish with an uncited claim
    expect(routeAfterCritic(state({ criticDecision: patch.criticDecision }))).not.toBe('finish')
  })

  it('keeps the model grounded verdict when every claim has a retrieved cite', async () => {
    // The deterministic gate is narrow: a fully pin-cited answer still finishes on a
    // model pass — the override fires only for genuinely uncited claims.
    const envelope = parseAnswerEnvelope({
      behaviorClass: 'answer',
      answer: 'The landlord must keep the unit in a good state of repair.',
      claims: [
        {
          text: 'The landlord must keep the unit in a good state of repair.',
          cites: [REPAIR_CANDIDATE.path],
        },
      ],
    })
    const patch = await criticNode(
      state({ candidates: [REPAIR_CANDIDATE], envelope }),
      scriptedModel(),
    )
    expect(patch.criticDecision?.grounded).toBe(true)
  })

  it('routes to re-retrieve when ungrounded and under the re-retrieval cap', () => {
    const s = state({
      criticDecision: { grounded: false, ungroundedClaims: ['x'] },
      criticReretrievals: 0,
    })
    expect(routeAfterCritic(s)).toBe('re-retrieve')
  })

  it('routes to degrade when ungrounded AT the re-retrieval cap', () => {
    const s = state({
      criticDecision: { grounded: false, ungroundedClaims: ['x'] },
      criticReretrievals: AGENT_LOOP_CAPS.maxCriticReretrievals,
    })
    expect(routeAfterCritic(s)).toBe('degrade')
  })

  it('counts a critic re-retrieval', () => {
    expect(bumpCriticReretrieval(state({ criticReretrievals: 0 })).criticReretrievals).toBe(1)
  })
})

describe('degradeNode', () => {
  it('drops ungrounded claims and marks the envelope degraded', () => {
    const envelope = parseAnswerEnvelope({
      behaviorClass: 'answer',
      answer: 'The landlord pays. The tenant also pays everything.',
      claims: [
        { text: 'The landlord pays.', cites: [REPAIR_CANDIDATE.path] },
        { text: 'The tenant also pays everything.', cites: [] },
      ],
    })
    const patch = degradeNode(
      state({
        candidates: [REPAIR_CANDIDATE],
        envelope,
        criticDecision: { grounded: false, ungroundedClaims: ['The tenant also pays everything.'] },
      }),
    )
    expect(patch.degraded).toBe(true)
    expect(patch.envelope?.claims).toHaveLength(1)
    expect(patch.envelope?.claims[0]!.text).toBe('The landlord pays.')
  })

  it('rebuilds the degraded prose from kept claims so withheld content never survives', () => {
    // The dropped claim must not linger in the human-facing answer while the note
    // says it was withheld — rebuild the prose from the kept claims, not the draft.
    const envelope = parseAnswerEnvelope({
      behaviorClass: 'answer',
      answer: 'The landlord pays. The tenant also pays everything.',
      claims: [
        { text: 'The landlord pays.', cites: [REPAIR_CANDIDATE.path] },
        { text: 'The tenant also pays everything.', cites: [] },
      ],
    })
    const patch = degradeNode(
      state({
        candidates: [REPAIR_CANDIDATE],
        envelope,
        criticDecision: { grounded: false, ungroundedClaims: ['The tenant also pays everything.'] },
      }),
    )
    expect(patch.envelope?.answer).not.toContain('The tenant also pays everything.')
    expect(patch.envelope?.answer).toContain('The landlord pays.')
    expect(patch.envelope?.answer).toMatch(/withheld/i)
  })

  it('degrades to an honest no-answer when nothing is grounded', () => {
    const envelope = parseAnswerEnvelope({
      behaviorClass: 'answer',
      answer: 'made up',
      claims: [{ text: 'made up', cites: [] }],
    })
    const patch = degradeNode(
      state({ envelope, criticDecision: { grounded: false, ungroundedClaims: ['made up'] } }),
    )
    expect(patch.envelope?.claims).toEqual([])
    expect(patch.envelope?.answer).toMatch(/do not confirm|consult/i)
  })
})
