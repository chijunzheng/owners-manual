/**
 * The agent graph's node functions (#15), pure and provider-free so the whole
 * graph is driven by a SCRIPTED FAKE model in tests (never a live Vertex call).
 *
 * Each function is a LangGraph node: it takes the {@link AgentState} plus the
 * injected seams and returns a PARTIAL state update (immutable — no mutation,
 * per coding style). The bounded-loop decisions live in the routers
 * ({@link routeAfterGuard}, {@link routeAfterCritic}); the caps they enforce are
 * {@link AGENT_LOOP_CAPS}. Plans are hop-capped at the Planner; reformulation is
 * capped at retrieve; Critic re-retrieval is capped at the critic router — so
 * Guard and Critic ALWAYS run and the trajectory is bounded and comparable
 * across eval runs (CONTEXT.md, "Planner").
 */

import {
  parseAnswerEnvelope,
  type AnswerEnvelope,
  type AnswerBehaviorClass,
} from './answer-envelope.js'
import {
  AGENT_LOOP_CAPS,
  guardVerdictToBehavior,
  type AgentModel,
  type AgentRetrieve,
  type AgentState,
  type RetrievalPlan,
} from './agent-types.js'
import { citablePathsEqual, type CitablePath } from '@owners-manual/core'
import { authorityRank } from './authority.js'
import { type HybridCandidate } from './hybrid-retrieve.js'

/** A node's partial-state return — every node yields an immutable patch. */
export type AgentStatePatch = Partial<AgentState>

/** The default retrieval top-k the agent's retrieve node asks for per hop. */
export const AGENT_TOP_K_DEFAULT = 8

// --- guard -----------------------------------------------------------------

/**
 * Guard node: run the injected guard, then short-circuit to a refusal envelope
 * when the verdict is not `pass` — a refusal carries the matching behavior class
 * and an EMPTY claims list (answer-envelope contract: the asserted behavior is
 * the refusal itself). Injection detected forces an out-of-scope refusal even if
 * the verdict said pass, so untrusted-content injection can never reach synthesis.
 */
export async function guardNode(state: AgentState, model: AgentModel): Promise<AgentStatePatch> {
  const guard = await model.guard({ question: state.question })
  const effective =
    guard.injectionDetected && guard.verdict === 'pass'
      ? { ...guard, verdict: 'refuse-out-of-scope' as const }
      : guard

  if (effective.verdict === 'pass') {
    return { guardDecision: effective }
  }

  const behaviorClass = guardVerdictToBehavior(effective.verdict)
  return { guardDecision: effective, envelope: refusalEnvelope(behaviorClass, effective.reason) }
}

/** A schema-valid refusal envelope: the behavior class plus an empty claim list. */
export function refusalEnvelope(
  behaviorClass: AnswerBehaviorClass,
  reason: string,
): AnswerEnvelope {
  return parseAnswerEnvelope({
    behaviorClass,
    answer: reason,
    claims: [],
  })
}

/** Route after the guard: stop on a refusal (envelope already set), else plan. */
export function routeAfterGuard(state: AgentState): 'plan' | 'refused' {
  return state.envelope ? 'refused' : 'plan'
}

// --- planner ---------------------------------------------------------------

/**
 * Planner node: get a retrieval plan from the model and CLAMP it to the hop cap.
 * Clamping at the Planner is the structural guarantee that no plan can schedule
 * an unbounded fan-out — the hop count is bounded before any retrieval runs.
 */
export async function plannerNode(state: AgentState, model: AgentModel): Promise<AgentStatePatch> {
  const raw = await model.plan({ question: state.question })
  return { plan: clampPlan(raw) }
}

/** Clamp a plan to at most {@link AGENT_LOOP_CAPS.maxHops} hops (≥ 1). */
export function clampPlan(plan: RetrievalPlan): RetrievalPlan {
  const hops = plan.hops.slice(0, AGENT_LOOP_CAPS.maxHops)
  const safeHops = hops.length > 0 ? hops : [{ query: '' }]
  return { hops: safeHops, multiHop: plan.multiHop && safeHops.length > 1 }
}

// --- retrieve --------------------------------------------------------------

/**
 * Retrieve node: run the planned hops through the injected (frozen #14) hybrid
 * retrieval and merge their candidates, de-duplicated by citable-path key,
 * highest fused score kept. Consumes the question for an empty-query hop so a
 * degenerate plan still retrieves something to ground the answer on.
 */
export async function retrieveNode(
  state: AgentState,
  retrieve: AgentRetrieve,
  topK: number = AGENT_TOP_K_DEFAULT,
): Promise<AgentStatePatch> {
  const plan = state.plan ?? { hops: [{ query: state.question }], multiHop: false }
  const perHop = await Promise.all(
    plan.hops.map((hop) =>
      retrieve({
        question: hop.query || state.question,
        topK,
        authorityLevels: hop.authorityLevels,
      }),
    ),
  )
  return { candidates: mergeCandidates(perHop.flat()) }
}

/** Merge candidate lists, keeping the highest-scored row per path key, score-desc. */
export function mergeCandidates(lists: readonly HybridCandidate[]): readonly HybridCandidate[] {
  const byKey = new Map<string, HybridCandidate>()
  for (const candidate of lists) {
    const existing = byKey.get(candidate.citablePathKey)
    if (!existing || candidate.score > existing.score) {
      byKey.set(candidate.citablePathKey, candidate)
    }
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score)
}

// --- rerank ----------------------------------------------------------------

/**
 * Rerank node (basic): authority-weighted, then fused-score. ADR 0002's
 * authority hierarchy is the tiebreak — a higher-authority candidate outranks a
 * lower-authority one at equal-ish relevance, so the synthesizer sees the
 * governing source first. Deterministic and provider-free (the "basic" rerank
 * the issue calls for; a cross-encoder is a later component on the ladder).
 */
export function rerankNode(state: AgentState): AgentStatePatch {
  return { candidates: rerankByAuthority(state.candidates) }
}

/** Stable authority-then-score ordering (higher authority and score first). */
export function rerankByAuthority(
  candidates: readonly HybridCandidate[],
): readonly HybridCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.authorityLevel !== b.authorityLevel) {
      // Lower rank == higher authority, so ascending puts Acts first (ADR 0002).
      return authorityRank(a.authorityLevel) - authorityRank(b.authorityLevel)
    }
    return b.score - a.score
  })
}

// --- synthesize ------------------------------------------------------------

/**
 * Synthesize node: stream the answer from the candidates and parse the raw
 * model output into a schema-valid envelope, CLAMPED to the candidate set so the
 * agent (like the naive arm) cannot inflate cite precision by inventing a
 * pin-cite it never retrieved. `onToken` streams each chunk to the SSE client;
 * the same run yields the structured envelope the harness scores.
 */
export async function synthesizeNode(
  state: AgentState,
  model: AgentModel,
  onToken?: (token: string) => void,
): Promise<AgentStatePatch> {
  const raw = await model.synthesize({
    question: state.question,
    candidates: state.candidates,
    onToken,
  })
  const envelope = clampEnvelopeToCandidates(parseRawEnvelope(raw), state.candidates)
  return { envelope, rawModelOutput: raw }
}

/** Strip a ```json fence the model may wrap the envelope JSON in, then parse. */
function parseRawEnvelope(raw: string): AnswerEnvelope {
  const trimmed = raw.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  const body = fence?.[1]?.trim() ?? trimmed
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`agent synthesis did not return valid JSON: ${reason}`)
  }
  return parseAnswerEnvelope(parsed)
}

/** True when `cite` matches one of the candidate addresses (hierarchically equal). */
function isRetrieved(cite: CitablePath, candidates: readonly HybridCandidate[]): boolean {
  return candidates.some((candidate) => citablePathsEqual(candidate.path, cite))
}

/** Drop any cite the model offered that was not actually in the candidate set. */
export function clampEnvelopeToCandidates(
  envelope: AnswerEnvelope,
  candidates: readonly HybridCandidate[],
): AnswerEnvelope {
  return {
    ...envelope,
    claims: envelope.claims.map((claim) => ({
      ...claim,
      cites: claim.cites.filter((cite) => isRetrieved(cite, candidates)),
    })),
  }
}

// --- critic ----------------------------------------------------------------

/**
 * Critic node: verify every answer claim maps to a retrieved candidate. On
 * failure the router decides — re-retrieve once, or degrade honestly. The Critic
 * NEVER rewrites the answer to guess; it only gates and, at the cap, marks the
 * envelope degraded (CONTEXT.md, "Critic gate": degrade honestly rather than
 * guessing).
 */
export async function criticNode(state: AgentState, model: AgentModel): Promise<AgentStatePatch> {
  // A refusal envelope (from Guard) carries no claims — nothing to ground; pass.
  const answer = state.envelope?.answer ?? ''
  const critic = await model.critique({
    question: state.question,
    answer,
    candidates: state.candidates,
  })
  return { criticDecision: critic }
}

/**
 * Route after the critic: grounded → finish; ungrounded with re-retrieval budget
 * → re-retrieve (a NEW plan-then-retrieve pass, bounded by
 * {@link AGENT_LOOP_CAPS.maxCriticReretrievals}); ungrounded at the cap →
 * degrade. The budget check is what makes the loop bounded, not open-ended.
 */
export function routeAfterCritic(state: AgentState): 'finish' | 're-retrieve' | 'degrade' {
  if (state.criticDecision?.grounded ?? true) {
    return 'finish'
  }
  if (state.criticReretrievals < AGENT_LOOP_CAPS.maxCriticReretrievals) {
    return 're-retrieve'
  }
  return 'degrade'
}

/** Count a Critic-triggered re-retrieval before re-entering the retrieve pass. */
export function bumpCriticReretrieval(state: AgentState): AgentStatePatch {
  return { criticReretrievals: state.criticReretrievals + 1 }
}

/**
 * Degrade node: the Critic stayed ungrounded at the re-retrieval cap. Strip the
 * ungrounded claims rather than guessing, mark the envelope degraded, and append
 * an honest note. A wholly-ungrounded answer degrades to an honest "cannot
 * confirm from the sources" — never a fabricated cite.
 */
export function degradeNode(state: AgentState): AgentStatePatch {
  const envelope = state.envelope
  if (!envelope) return { degraded: true }
  const ungrounded = new Set(state.criticDecision?.ungroundedClaims ?? [])
  const keptClaims = envelope.claims.filter(
    (claim) => claim.cites.length > 0 && !ungrounded.has(claim.text),
  )
  const note =
    keptClaims.length > 0
      ? `${envelope.answer}\n\n(Some statements could not be confirmed against the cited sources and were withheld.)`
      : 'The retrieved sources do not confirm an answer to this question; please consult the authoritative source directly.'
  return {
    degraded: true,
    envelope: { ...envelope, answer: note, claims: keptClaims },
  }
}

// --- helpers ---------------------------------------------------------------

/** The behavior class of the terminal envelope, or `answer` before synthesis. */
export function terminalBehavior(state: AgentState): AnswerBehaviorClass {
  return state.envelope?.behaviorClass ?? 'answer'
}
