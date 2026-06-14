/**
 * The agent graph's shared contracts (#15): the state every node reads/writes,
 * the bounded-loop caps, and the injected node seams (model + retrieval).
 *
 * The agent is a LangGraph.js graph — Guard → Planner → retrieve → rerank →
 * synthesize → Critic — whose iteration is ENTIRELY explicit bounded edges
 * (CONTEXT.md, "Planner": never an open-ended ReAct scratchpad). The caps live
 * here as named constants so the topology, the loop bounds, and the five
 * behavior classes are pinned by tests against a SCRIPTED FAKE model — never a
 * live Vertex call (issue #15). The runtime model (`ChatVertexAI`, ADR 0005)
 * binds behind the {@link AgentModel} seam in the service/CLI, exactly as the
 * naive-rag arm binds its `LlmComplete`.
 */

import { type AnswerBehaviorClass } from './answer-envelope.js'
import { type AuthorityLevel } from './authority.js'
import { type HybridCandidate, type RetrieveHybridOptions } from './hybrid-retrieve.js'

/**
 * The bounded-loop caps — the heart of "all iteration is explicit bounded edges"
 * (CONTEXT.md, "Planner"/"Critic gate"). Each is enforced by a graph edge AND
 * asserted by a test, so a regression that turns a bounded loop into an
 * open-ended one fails CI.
 */
export const AGENT_LOOP_CAPS = {
  /** Max retrieval hops the Planner may schedule in one plan (hop-capped plans). */
  maxHops: 3,
  /** Max query reformulations at the retrieve node (reformulate ≤ 1). */
  maxReformulations: 1,
  /** Max Critic-triggered re-retrievals before honest degradation (≤ 1). */
  maxCriticReretrievals: 1,
} as const

/** The four guard verdicts: pass, or one of the three refusal classes a guard owns. */
export const GUARD_VERDICTS = [
  'pass',
  'refuse-jurisdiction',
  'refuse-out-of-scope',
  'refuse-advice-escalate',
] as const

export type GuardVerdict = (typeof GUARD_VERDICTS)[number]

/** The Guard node's structured decision (jurisdiction, scope, injection, advice). */
export interface GuardDecision {
  /** The verdict — `pass` lets the plan proceed; the rest are terminal refusals. */
  readonly verdict: GuardVerdict
  /** Whether prompt-injection was detected in untrusted content (logged, refuses out-of-scope). */
  readonly injectionDetected: boolean
  /** A short human-facing reason, surfaced in a refusal envelope's answer prose. */
  readonly reason: string
}

/** One hop of a retrieval plan: a query, optionally narrowed to corpora/authority. */
export interface RetrievalHop {
  /** The query to retrieve for this hop (may differ from the user question). */
  readonly query: string
  /** Authority levels this hop restricts to, if any (ADR 0002 metadata filter). */
  readonly authorityLevels?: readonly AuthorityLevel[]
}

/** The Planner's structured, hop-capped retrieval plan. */
export interface RetrievalPlan {
  /** The ordered hops — length is clamped to {@link AGENT_LOOP_CAPS.maxHops}. */
  readonly hops: readonly RetrievalHop[]
  /** Whether the plan fans out across corpora (cross-corpus question). */
  readonly multiHop: boolean
}

/** The Critic's post-synthesis verdict over the drafted envelope. */
export interface CriticDecision {
  /** True when every answer claim maps to a retrieved candidate. */
  readonly grounded: boolean
  /** The claim texts whose cites were NOT in the candidate set (ungrounded). */
  readonly ungroundedClaims: readonly string[]
}

/**
 * The injected model seam — the agent's three LLM-shaped decisions, each a
 * narrow string-in/value-out call so the whole graph is driven by a SCRIPTED
 * FAKE in tests. The live binding wraps one `ChatVertexAI` (ADR 0005).
 */
export interface AgentModel {
  /** Guard the question: jurisdiction, topical scope, injection, advice boundary. */
  guard(input: { readonly question: string }): Promise<GuardDecision>
  /** Plan retrieval: emit a hop-capped {@link RetrievalPlan} for the question. */
  plan(input: { readonly question: string }): Promise<RetrievalPlan>
  /**
   * Synthesize a streamed answer from the candidates. `onToken` is called with
   * each chunk so the SSE endpoint streams; the resolved string is the full raw
   * model output the envelope is parsed from (one artifact, two consumers).
   */
  synthesize(input: {
    readonly question: string
    readonly candidates: readonly HybridCandidate[]
    readonly onToken?: (token: string) => void
  }): Promise<string>
  /** Critique the drafted answer: does every claim map to a retrieved candidate? */
  critique(input: {
    readonly question: string
    readonly answer: string
    readonly candidates: readonly HybridCandidate[]
  }): Promise<CriticDecision>
}

/**
 * The retrieval seam the agent's retrieve node consumes: #14's `retrieveHybrid`
 * minus the providers the graph doesn't own. The live binding partially-applies
 * the embedding provider + Atlas executors; tests inject a scripted fake. The
 * hybrid contract is FROZEN (#14) — the agent CONSUMES it, never reshapes it.
 */
export type AgentRetrieve = (input: {
  readonly question: string
  readonly topK: number
  readonly authorityLevels?: readonly AuthorityLevel[]
}) => Promise<readonly HybridCandidate[]>

/** The injected options the live binding closes `retrieveHybrid` over. */
export type AgentRetrieveDeps = Pick<
  RetrieveHybridOptions,
  'provider' | 'vectorSearch' | 'textSearch'
>

/**
 * The agent's full state (the LangGraph channels). Immutable per CONTEXT/coding
 * style: nodes return partial updates, never mutate. The terminal `envelope`
 * carries the behavior class — one of the five {@link AnswerBehaviorClass} — and
 * the pin-cited claims; refusals carry an empty claim list.
 */
export interface AgentState {
  readonly question: string
  readonly itemId?: string
  /**
   * The Guard decision; set by the guard node. Named `guardDecision` (not
   * `guard`) because a LangGraph state channel may not share a name with a graph
   * node — and `guard` is a node.
   */
  readonly guardDecision?: GuardDecision
  /** The retrieval plan; set by the planner node. */
  readonly plan?: RetrievalPlan
  /** The current retrieved candidate set; replaced each retrieve pass. */
  readonly candidates: readonly HybridCandidate[]
  /** How many reformulations have happened at retrieve (cap: maxReformulations). */
  readonly reformulations: number
  /** How many Critic re-retrievals have happened (cap: maxCriticReretrievals). */
  readonly criticReretrievals: number
  /** The Critic's last verdict; set by the critic node (named to avoid the `critic` node). */
  readonly criticDecision?: CriticDecision
  /** Whether the answer was honestly degraded (Critic still ungrounded at the cap). */
  readonly degraded: boolean
  /** The terminal answer envelope — the one artifact the UI and harness consume. */
  readonly envelope?: import('./answer-envelope.js').AnswerEnvelope
  /** The raw model synthesis text, kept for trace capture. */
  readonly rawModelOutput?: string
}

/** Map a non-pass guard verdict to its terminal behavior class. */
export function guardVerdictToBehavior(verdict: GuardVerdict): AnswerBehaviorClass {
  if (verdict === 'pass') {
    throw new Error('guardVerdictToBehavior called on a passing verdict')
  }
  return verdict
}
