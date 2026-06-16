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
  effectiveQuestion,
  guardVerdictToBehavior,
  type AgentEnrichmentAccess,
  type AgentModel,
  type AgentRerank,
  type AgentRetrieve,
  type AgentState,
  type RetrievalPlan,
} from './agent-types.js'
import { type AgentQueryFlags } from './agent-query-flags.js'
import { attachDefinitions, expandOneHop } from './graph-expansion.js'
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
 *
 * Plans for the {@link effectiveQuestion}: the reformulated query once the
 * reformulate edge has run (#53), else the original. Before any reformulation
 * this is exactly `state.question` (the #15 behaviour) — so a re-plan after a
 * thin first pass targets the rewritten query, while every other path is
 * unchanged.
 */
export async function plannerNode(state: AgentState, model: AgentModel): Promise<AgentStatePatch> {
  const raw = await model.plan({ question: effectiveQuestion(state) })
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
 * The #16 query-time extras the retrieve node closes over: the ablation flags
 * and the read-only access to #13's tree-level sidecars. Optional so the #15
 * call shape (retrieve only) still works and behaves as the all-off fallback.
 */
export interface RetrieveNodeExtras {
  readonly flags: AgentQueryFlags
  readonly enrichment?: AgentEnrichmentAccess
}

/**
 * Retrieve node: run the planned hops through the injected (frozen #14) hybrid
 * retrieval and merge their candidates, de-duplicated by citable-path key,
 * highest fused score kept. Consumes the question for an empty-query hop so a
 * degenerate plan still retrieves something to ground the answer on.
 *
 * Then, behind #16's flags (default off — the documented fallback is the
 * #15 path): when `xrefExpansion` is on, expand ONE hop over the cross-reference
 * sidecar (tagging pulled-in candidates `graph-expansion`); when
 * `definitionsInPrompt` is on, select the definitions the candidates mention so
 * synthesis can use them. Both consume the injected enrichment access — no flag,
 * no enrichment access, or no edges all collapse to the plain hybrid result.
 */
export async function retrieveNode(
  state: AgentState,
  retrieve: AgentRetrieve,
  topK: number = AGENT_TOP_K_DEFAULT,
  extras?: RetrieveNodeExtras,
): Promise<AgentStatePatch> {
  // The effective question is the reformulated query once the reformulate edge
  // has run (#53), else the original — so a degenerate (empty-query) hop on the
  // SECOND pass falls back to the rewrite, while the first pass and every off
  // run fall back to `state.question` exactly as in #15.
  const question = effectiveQuestion(state)
  const plan = state.plan ?? { hops: [{ query: question }], multiHop: false }
  const perHop = await Promise.all(
    plan.hops.map((hop) =>
      retrieve({
        question: hop.query || question,
        topK,
        authorityLevels: hop.authorityLevels,
      }),
    ),
  )
  const retrieved = mergeCandidates(perHop.flat())

  const flags = extras?.flags
  const enrichment = extras?.enrichment
  if (!flags || !enrichment) {
    return { candidates: retrieved }
  }

  const candidates = flags.xrefExpansion
    ? expandOneHop({
        seeds: retrieved,
        crossReferences: enrichment.crossReferencesFor(retrieved),
        lookup: enrichment.lookup,
      })
    : retrieved

  const definitionAttachments = flags.definitionsInPrompt
    ? attachDefinitions({ candidates, definitions: enrichment.definitionsFor(candidates) })
    : []

  return { candidates, definitionAttachments }
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

// --- reformulate (bounded edge, #16 + #53) ---------------------------------

/**
 * Reformulate node (#16 edge, made real in #53, ADR 0006): REWRITE the query for
 * a second retrieval pass and count the reformulation before re-entering
 * planning. The cap ({@link AGENT_LOOP_CAPS.maxReformulations}) is enforced by the
 * ROUTER ({@link routeAfterRetrieve}), so this never exceeds it and the loop
 * always terminates.
 *
 * The rewrite comes from the INJECTED {@link AgentModel.reformulate} seam — no
 * provider call lives here, so the node is unit-tested offline against a
 * deterministic fake. The rewrite is derived from the ORIGINAL `state.question`
 * (preserved for provenance) and stored as `reformulatedQuestion`; from there
 * {@link effectiveQuestion} makes the planner re-plan and the retrieve node search
 * the rewritten query — so the second pass differs from the first (closing the
 * #16 no-op gap, Codex P2 on PR #52). Reformulating from the original (not a prior
 * rewrite) keeps provenance stable; the ≤1 cap means it only happens once anyway.
 *
 * Only reached when `queryReformulation` is on AND the first pass was thin (the
 * router's contract), so an off run never calls the seam and stays byte-identical
 * to the #15 baseline.
 */
export async function reformulateNode(
  state: AgentState,
  model: AgentModel,
): Promise<AgentStatePatch> {
  const reformulatedQuestion = await model.reformulate({
    question: state.question,
    candidates: state.candidates,
  })
  return { reformulatedQuestion, reformulations: state.reformulations + 1 }
}

/**
 * Route after retrieve (#16): the bounded reformulation decision. Reformulate
 * ONLY when the flag is on, this is the FIRST (pre-Critic) retrieve pass, the
 * candidate set came back thin (empty), AND the reformulation budget is unspent —
 * otherwise proceed to rerank. With the flag off (the documented fallback) this
 * ALWAYS routes to rerank: a single retrieve pass, never a reformulation, so
 * Guard/Critic still always run and the trajectory stays bounded and comparable
 * (CONTEXT.md, "Planner").
 *
 * The first-pass guard (`criticReretrievals === 0`) matters because this same
 * edge is reused after critic → reretrieve → planner → retrieve: reformulation is
 * a rescue for a thin FIRST pass, not the Critic recovery path. Letting it fire on
 * a thin re-retrieval would add an extra model rewrite + retrieve cycle and divert
 * the bounded degrade route the Critic loop is supposed to reach. [Codex P2, PR #54]
 */
export function routeAfterRetrieve(
  state: AgentState,
  flags: AgentQueryFlags,
): 'rerank' | 'reformulate' {
  if (!flags.queryReformulation) return 'rerank'
  if (state.criticReretrievals > 0) return 'rerank'
  if (state.candidates.length > 0) return 'rerank'
  if (state.reformulations >= AGENT_LOOP_CAPS.maxReformulations) return 'rerank'
  return 'reformulate'
}

// --- rerank ----------------------------------------------------------------

/** The #16 rerank extras the rerank node closes over: the flags and the seam. */
export interface RerankNodeExtras {
  readonly flags: AgentQueryFlags
  readonly rerank: AgentRerank
}

/**
 * Rerank node (#16): when the `rerank` flag is on, run the INJECTED reranker
 * (authority / Cohere / LLM — selected by `rerankProvider`, bound live), which
 * tags its survivors `rerank-survivor`. When off (the documented fallback) the
 * candidates pass through UNCHANGED in their raw RRF/similarity (fused-score)
 * order — no authority weighting, no survivor tag. The seam is always injected so
 * the node stays provider-free; the flag only decides whether it fires.
 *
 * Returns a promise when reranking is on (the seam is async) and a plain patch
 * when off — both are valid LangGraph node returns, and the off path stays
 * synchronous so the fallback never awaits a provider it will not call.
 */
export function rerankNode(
  state: AgentState,
  extras: RerankNodeExtras,
): AgentStatePatch | Promise<AgentStatePatch> {
  if (!extras.flags.rerank) {
    return { candidates: state.candidates }
  }
  return extras
    .rerank({ question: state.question, candidates: state.candidates })
    .then((candidates) => ({ candidates }))
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
  // The two #17 mechanisms travel together as `memory` but stay DISTINCT in the
  // prompt (separate blocks). Only build the object when at least one is present,
  // so a no-memory run passes `undefined` and the off-state prompt is unchanged.
  const memory =
    state.ownerProfile || state.sessionMemory
      ? { ownerProfile: state.ownerProfile, sessionMemory: state.sessionMemory }
      : undefined
  const raw = await model.synthesize({
    question: state.question,
    candidates: state.candidates,
    definitions: state.definitionAttachments,
    memory,
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

  // Deterministic pin-cite gate. The model critic only sees the prose + sources,
  // not the claim→cite mapping, so it can pass a claim whose cites were all
  // stripped (clampEnvelopeToCandidates drops any non-retrieved cite). A claim
  // with no cite is ungrounded BY CONSTRUCTION — and because clamping already
  // removed unretrieved cites, `cites.length > 0` ⟹ a retrieved cite backs it.
  // This override is authoritative over the model verdict (CONTEXT.md, "Critic
  // gate": every claim carries a pin-cite verified against retrieved chunks).
  const uncited = (state.envelope?.claims ?? []).filter((claim) => claim.cites.length === 0)
  if (uncited.length === 0) {
    return { criticDecision: critic }
  }
  return {
    criticDecision: {
      grounded: false,
      ungroundedClaims: [
        ...new Set([...critic.ungroundedClaims, ...uncited.map((claim) => claim.text)]),
      ],
    },
  }
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
  // Rebuild the human-facing prose from ONLY the kept claims — never the original
  // draft. The draft answer contains the ungrounded sentences too, so reusing it
  // would show withheld content while the note claims it was withheld (CONTEXT.md,
  // "Critic gate": degrade honestly, never parrot unconfirmed text).
  const note =
    keptClaims.length > 0
      ? `${keptClaims.map((claim) => claim.text).join(' ')}\n\n(Some statements could not be confirmed against the cited sources and were withheld.)`
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
