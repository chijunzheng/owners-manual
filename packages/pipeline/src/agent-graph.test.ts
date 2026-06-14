import { describe, expect, it } from 'vitest'

import { END, START } from '@langchain/langgraph'

import {
  AGENT_LOOP_CAPS,
  AGENT_NODES,
  buildAgentGraph,
  runAgentGraph,
  type AgentGraphDeps,
} from './agent-graph.js'
import {
  candidate,
  REPAIR_CANDIDATE,
  scriptedModel,
  VOID_CLAUSE_CANDIDATE,
  type ScriptedModelOptions,
} from './agent-fixtures.js'
import { ANSWER_BEHAVIOR_CLASSES } from './answer-envelope.js'
import { type AgentRetrieve } from './agent-types.js'

/** A retrieve seam that always returns the repair candidate. */
const retrieveRepair: AgentRetrieve = async () => [REPAIR_CANDIDATE]

/** Build graph deps from a scripted-model config + a retrieve seam. */
function deps(
  modelOptions: ScriptedModelOptions = {},
  retrieve: AgentRetrieve = retrieveRepair,
): AgentGraphDeps & { model: ReturnType<typeof scriptedModel> } {
  const model = scriptedModel(modelOptions)
  return { model, retrieve }
}

// --- topology (pinned) -----------------------------------------------------

describe('agent graph topology', () => {
  it('compiles with exactly the Guard→Critic node set', () => {
    const graph = buildAgentGraph(deps())
    const nodes = Object.keys(graph.getGraph().nodes)
    for (const name of AGENT_NODES) {
      expect(nodes).toContain(name)
    }
  })

  it('wires Guard as the entry node and routes a refusal straight to the end', () => {
    const graph = buildAgentGraph(deps())
    const drawn = graph.getGraph()
    const edges = drawn.edges.map((e) => `${e.source}->${e.target}`)
    // START enters guard; guard can reach the planner (pass) and END (refused).
    expect(edges).toContain(`${START}->guard`)
    expect(edges.some((e) => e === 'guard->planner')).toBe(true)
    expect(edges.some((e) => e.startsWith('guard->') && e.endsWith(END))).toBe(true)
  })

  it('runs the nodes in the bounded order: planner→retrieve→rerank→synthesize→critic', () => {
    const graph = buildAgentGraph(deps())
    const edges = graph.getGraph().edges.map((e) => `${e.source}->${e.target}`)
    expect(edges).toContain('planner->retrieve')
    expect(edges).toContain('retrieve->rerank')
    expect(edges).toContain('rerank->synthesize')
    expect(edges).toContain('synthesize->critic')
  })

  it('wires the single bounded re-retrieval as critic→reretrieve→planner', () => {
    const graph = buildAgentGraph(deps())
    const edges = graph.getGraph().edges.map((e) => `${e.source}->${e.target}`)
    expect(edges).toContain('reretrieve->planner')
    expect(edges.some((e) => e.startsWith('critic->') && e.includes('reretrieve'))).toBe(true)
  })
})

// --- the answer path with pin-cites (AC1) ----------------------------------

describe('agent graph — answer with pin-cites', () => {
  it('answers a tenancy question with a pin-cited claim', async () => {
    const state = await runAgentGraph('who repairs the unit?', deps())
    expect(state.envelope?.behaviorClass).toBe('answer')
    expect(state.envelope?.claims).toHaveLength(1)
    expect(state.envelope?.claims[0]!.cites).toHaveLength(1)
    expect(state.envelope?.claims[0]!.cites[0]!.documentId).toBe('rta-2006')
  })

  it('streams synthesis tokens through the onToken sink', async () => {
    const tokens: string[] = []
    const model = scriptedModel({ streamChunks: 5 })
    await runAgentGraph('who repairs the unit?', {
      model,
      retrieve: retrieveRepair,
      onToken: (t) => tokens.push(t),
    })
    expect(tokens.length).toBeGreaterThan(1)
    expect(tokens.join('')).toContain('behaviorClass')
  })

  it('reranks an Act above a contract before synthesis', async () => {
    const retrieveBoth: AgentRetrieve = async () => [VOID_CLAUSE_CANDIDATE, REPAIR_CANDIDATE]
    let firstSeen: string | undefined
    const model = scriptedModel()
    const spyModel = {
      ...model,
      synthesize: async (input: Parameters<typeof model.synthesize>[0]) => {
        firstSeen = input.candidates[0]?.documentId
        return model.synthesize(input)
      },
    }
    await runAgentGraph('who pays for damage?', { model: spyModel, retrieve: retrieveBoth })
    expect(firstSeen).toBe('rta-2006')
  })
})

// --- all five behavior classes reachable (AC2) -----------------------------

describe('agent graph — five behavior classes', () => {
  it('reaches answer', async () => {
    const state = await runAgentGraph('q', deps())
    expect(state.envelope?.behaviorClass).toBe('answer')
  })

  it('reaches refuse-jurisdiction', async () => {
    const state = await runAgentGraph(
      'q',
      deps({
        guard: {
          verdict: 'refuse-jurisdiction',
          injectionDetected: false,
          reason: 'BC, not Ontario',
        },
      }),
    )
    expect(state.envelope?.behaviorClass).toBe('refuse-jurisdiction')
  })

  it('reaches refuse-out-of-scope', async () => {
    const state = await runAgentGraph(
      'q',
      deps({
        guard: { verdict: 'refuse-out-of-scope', injectionDetected: false, reason: 'off-topic' },
      }),
    )
    expect(state.envelope?.behaviorClass).toBe('refuse-out-of-scope')
  })

  it('reaches refuse-advice-escalate', async () => {
    const state = await runAgentGraph(
      'q',
      deps({
        guard: {
          verdict: 'refuse-advice-escalate',
          injectionDetected: false,
          reason: 'see a lawyer',
        },
      }),
    )
    expect(state.envelope?.behaviorClass).toBe('refuse-advice-escalate')
  })

  it('reaches flag-void-clause', async () => {
    const voidOutput = JSON.stringify({
      behaviorClass: 'flag-void-clause',
      answer: 'The lease term is void; the Act overrides it.',
      claims: [
        {
          text: 'The lease term is void.',
          cites: [{ documentId: 'fixture-lease', segments: [{ kind: 'section', label: '7' }] }],
        },
      ],
    })
    const state = await runAgentGraph('is my lease clause void?', {
      model: scriptedModel({ synthesisOutputs: [voidOutput] }),
      retrieve: async () => [VOID_CLAUSE_CANDIDATE],
    })
    expect(state.envelope?.behaviorClass).toBe('flag-void-clause')
  })

  it('every behavior class in the envelope enum is one a run can assert', () => {
    // Guards the test list against the canonical five (a regression tripwire).
    expect([...ANSWER_BEHAVIOR_CLASSES].sort()).toEqual([
      'answer',
      'flag-void-clause',
      'refuse-advice-escalate',
      'refuse-jurisdiction',
      'refuse-out-of-scope',
    ])
  })
})

// --- bounded-loop caps (AC3) -----------------------------------------------

describe('agent graph — bounded-loop caps', () => {
  it('a refusal never plans, retrieves, or synthesizes (Guard short-circuits)', async () => {
    const d = deps({
      guard: { verdict: 'refuse-jurisdiction', injectionDetected: false, reason: 'BC' },
    })
    await runAgentGraph('q', d)
    expect(d.model.calls.plan).toBe(0)
    expect(d.model.calls.synthesize).toBe(0)
  })

  it('caps Critic re-retrieval at one then degrades honestly', async () => {
    // Critic always reports ungrounded — the loop MUST stop after one re-retrieval.
    const ungrounded = {
      grounded: false,
      ungroundedClaims: ['The landlord must keep the unit in a good state of repair.'],
    }
    const d = deps({ critiques: [ungrounded, ungrounded, ungrounded, ungrounded] })
    const state = await runAgentGraph('who repairs the unit?', d)
    expect(state.degraded).toBe(true)
    // One initial pass + exactly one re-retrieval = 2 plan/synthesize calls, no more.
    expect(d.model.calls.plan).toBe(1 + AGENT_LOOP_CAPS.maxCriticReretrievals)
    expect(d.model.calls.synthesize).toBe(1 + AGENT_LOOP_CAPS.maxCriticReretrievals)
    expect(d.model.calls.critique).toBe(1 + AGENT_LOOP_CAPS.maxCriticReretrievals)
  })

  it('a grounded answer never triggers re-retrieval', async () => {
    const d = deps()
    const state = await runAgentGraph('who repairs the unit?', d)
    expect(state.degraded).toBe(false)
    expect(d.model.calls.synthesize).toBe(1)
    expect(d.model.calls.critique).toBe(1)
  })

  it('the one re-retrieval recovers when the critic is satisfied the second time', async () => {
    const d = deps({
      critiques: [
        { grounded: false, ungroundedClaims: ['x'] },
        { grounded: true, ungroundedClaims: [] },
      ],
    })
    const state = await runAgentGraph('who repairs the unit?', d)
    expect(state.degraded).toBe(false)
    expect(state.envelope?.behaviorClass).toBe('answer')
    expect(d.model.calls.synthesize).toBe(2)
  })

  it('clamps the planner hop count to maxHops even if the model over-plans', async () => {
    const overPlan = {
      hops: Array.from({ length: 9 }, (_v, i) => ({ query: `h${i}` })),
      multiHop: true,
    }
    const hopQueries: string[] = []
    const retrieve: AgentRetrieve = async ({ question }) => {
      hopQueries.push(question)
      return [REPAIR_CANDIDATE]
    }
    await runAgentGraph('q', { model: scriptedModel({ plans: [overPlan] }), retrieve })
    expect(hopQueries.length).toBe(AGENT_LOOP_CAPS.maxHops)
  })

  it('a degenerate single retrieved candidate still produces a bounded run', async () => {
    const d = deps({}, async () => [candidate('rta-2006|section:20', 'x', 0.5)])
    const state = await runAgentGraph('q', d)
    expect(state.envelope).toBeDefined()
    expect(d.model.calls.guard).toBe(1)
  })
})
