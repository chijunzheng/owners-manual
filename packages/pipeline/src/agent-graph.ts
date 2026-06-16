/**
 * The agent graph (#15): a LangGraph.js `StateGraph` wiring the node functions
 * into Guard → Planner → retrieve → rerank → synthesize → Critic, with ALL
 * iteration as explicit BOUNDED edges (CONTEXT.md, "Planner": never an open-ended
 * ReAct scratchpad). The topology, the bounded-loop caps, the envelope schema,
 * and all five behavior classes are pinned by tests against a SCRIPTED FAKE model
 * — the runtime model (`ChatVertexAI`, ADR 0005) only binds in the service/CLI.
 *
 * The bounded edges, made explicit:
 *   - Guard ALWAYS runs first; a refusal routes straight to END (guard → refused).
 *   - The Planner clamps hops to {@link AGENT_LOOP_CAPS.maxHops} before retrieval.
 *   - The Critic, on an ungrounded answer, re-enters retrieval at most
 *     {@link AGENT_LOOP_CAPS.maxCriticReretrievals} times (one re-retrieval), then
 *     routes to honest degradation — never an open loop.
 * The graph's `recursionLimit` is a belt-and-braces backstop: the routers already
 * bound every loop, so it can never actually fire on a well-formed run.
 */

import { END, START, StateGraph } from '@langchain/langgraph'

import {
  AGENT_LOOP_CAPS,
  type AgentEnrichmentAccess,
  type AgentModel,
  type AgentRerank,
  type AgentRetrieve,
  type AgentState,
} from './agent-types.js'
import { type OwnerProfile } from './owner-profile.js'
import { type SessionMemory } from './session-memory.js'
import { AGENT_QUERY_FLAGS_OFF, type AgentQueryFlags } from './agent-query-flags.js'
import {
  AGENT_TOP_K_DEFAULT,
  bumpCriticReretrieval,
  criticNode,
  degradeNode,
  guardNode,
  plannerNode,
  reformulateNode,
  rerankNode,
  retrieveNode,
  routeAfterCritic,
  routeAfterGuard,
  routeAfterRetrieve,
  synthesizeNode,
} from './agent-nodes.js'
import { authorityRerank } from './rerank.js'
import { AgentAnnotation } from './agent-state.js'

/** The graph node names — exported so the topology test asserts them by name. */
export const AGENT_NODES = [
  'guard',
  'planner',
  'retrieve',
  'reformulate',
  'rerank',
  'synthesize',
  'critic',
  'reretrieve',
  'degrade',
] as const

export type AgentNodeName = (typeof AGENT_NODES)[number]

/**
 * The seams the graph closes over: the model, retrieval, the rerank provider,
 * the query-time enrichment access, the ablation flags, top-k, token sink.
 *
 * The #16 additions are all optional with a documented all-off fallback, so the
 * #15 call shape ({ model, retrieve }) still compiles and runs the plain bounded
 * graph: `flags` defaults to {@link AGENT_QUERY_FLAGS_OFF} (no expansion, no
 * definitions, no reformulation, raw RRF order), `rerank` defaults to the
 * deterministic authority reranker (only consulted when the `rerank` flag is on),
 * and `enrichment` is absent (graph expansion / definitions both no-op).
 */
export interface AgentGraphDeps {
  readonly model: AgentModel
  readonly retrieve: AgentRetrieve
  /** The injected rerank provider; only consulted when the `rerank` flag is on. */
  readonly rerank?: AgentRerank
  /** Read-only access to #13's tree-level sidecars; absent disables expansion/defs. */
  readonly enrichment?: AgentEnrichmentAccess
  /** The query-time ablation flags; defaults to the all-off fallback. */
  readonly flags?: AgentQueryFlags
  readonly topK?: number
  /** Streamed-token sink for the SSE endpoint; absent in scoring-only runs. */
  readonly onToken?: (token: string) => void
}

/**
 * The recursion-limit backstop. With Guard once, hops clamped, and at most one
 * Critic re-retrieval, the longest path visits a small fixed number of
 * super-steps; this ceiling is comfortably above it and only guards against a
 * future wiring bug — it never fires on a correct run.
 */
export const AGENT_RECURSION_LIMIT = 24

/**
 * Build and compile the agent graph. Every node binds its injected seam here, so
 * the compiled graph is a pure function of (model, retrieve) — driven by a
 * scripted fake in tests and by `ChatVertexAI` + Atlas hybrid retrieval live.
 */
export function buildAgentGraph(deps: AgentGraphDeps) {
  const topK = deps.topK ?? AGENT_TOP_K_DEFAULT
  const flags = deps.flags ?? AGENT_QUERY_FLAGS_OFF
  const rerank = deps.rerank ?? authorityRerank

  const graph = new StateGraph(AgentAnnotation)
    .addNode('guard', (state) => guardNode(state, deps.model))
    .addNode('planner', (state) => plannerNode(state, deps.model))
    .addNode('retrieve', (state) =>
      retrieveNode(state, deps.retrieve, topK, { flags, enrichment: deps.enrichment }),
    )
    .addNode('reformulate', (state) => reformulateNode(state, deps.model))
    .addNode('rerank', (state) => rerankNode(state, { flags, rerank }))
    .addNode('synthesize', (state) => synthesizeNode(state, deps.model, deps.onToken))
    .addNode('critic', (state) => criticNode(state, deps.model))
    .addNode('reretrieve', (state) => bumpCriticReretrieval(state))
    .addNode('degrade', (state) => degradeNode(state))
    // Guard always runs first; a refusal routes straight to END.
    .addEdge(START, 'guard')
    .addConditionalEdges('guard', routeAfterGuard, { plan: 'planner', refused: END })
    .addEdge('planner', 'retrieve')
    // The one bounded reformulation (#16 edge, real rewrite in #53): retrieve →
    // reformulate → planner (re-plan over the REWRITTEN query) at most
    // maxReformulations times, ONLY behind the flag and only on a thin result;
    // otherwise straight to rerank. With the flag off this edge never fires.
    .addConditionalEdges('retrieve', (state) => routeAfterRetrieve(state, flags), {
      rerank: 'rerank',
      reformulate: 'reformulate',
    })
    .addEdge('reformulate', 'planner')
    .addEdge('rerank', 'synthesize')
    .addEdge('synthesize', 'critic')
    // The one bounded re-retrieval: critic → reretrieve → planner (re-plan) once.
    .addConditionalEdges('critic', routeAfterCritic, {
      finish: END,
      're-retrieve': 'reretrieve',
      degrade: 'degrade',
    })
    .addEdge('reretrieve', 'planner')
    .addEdge('degrade', END)

  return graph.compile()
}

/** The shape `runAgentGraph` returns: the terminal state, narrowed for callers. */
export interface AgentGraphResult {
  readonly state: AgentState
}

/**
 * The #17 memory injected into INITIAL graph state: the owner profile
 * (cross-session facts) and the bounded session summary, kept as DISTINCT
 * channels. Both optional — absent means the off-state (no memory in the prompt),
 * so the #15 call shape (`runAgentGraph(question, deps, itemId)`) is unchanged.
 */
export interface AgentGraphInitialMemory {
  readonly ownerProfile?: OwnerProfile
  readonly sessionMemory?: SessionMemory
}

/**
 * Run the compiled graph for one question and return the terminal state. The
 * `recursionLimit` is the backstop described above; the routers make the loops
 * bounded, so a real run never approaches it. `memory` seeds the two #17 state
 * channels (owner profile, session memory) the synthesize node reads — they are
 * set ONLY here on initial state and carried through, never written by a node.
 */
export async function runAgentGraph(
  question: string,
  deps: AgentGraphDeps,
  itemId?: string,
  memory?: AgentGraphInitialMemory,
): Promise<AgentState> {
  const graph = buildAgentGraph(deps)
  const final = await graph.invoke(
    {
      question,
      itemId,
      ownerProfile: memory?.ownerProfile,
      sessionMemory: memory?.sessionMemory,
    },
    { recursionLimit: AGENT_RECURSION_LIMIT },
  )
  return final
}

export { AGENT_LOOP_CAPS }
