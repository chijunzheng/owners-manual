/**
 * Test-only fixtures for the agent graph (#15): a SCRIPTED FAKE {@link AgentModel}
 * and candidate builders. Tests drive the whole graph through these — never a
 * live Vertex call (issue #15: the agent's tests use a scripted fake injected
 * into the graph). Kept in `src/` (not a test file) so both the nodes test and
 * the graph test import one canonical fake; it ships no live provider code.
 */

import { type CitablePath } from '@owners-manual/core'

import { authorityLevelOf } from './authority.js'
import {
  type AgentModel,
  type CriticDecision,
  type GuardDecision,
  type RetrievalPlan,
} from './agent-types.js'
import { parsePathKey } from './retrieve.js'
import { type HybridCandidate } from './hybrid-retrieve.js'

/** Build a {@link HybridCandidate} from a path key + text + fused score. */
export function candidate(citablePathKey: string, text: string, score: number): HybridCandidate {
  const path = parsePathKey(citablePathKey)
  return {
    documentId: path.documentId,
    citablePathKey,
    path,
    text,
    score,
    stage: 'hybrid',
    stages: ['bm25', 'vector'],
    stageRanks: { vector: 1, bm25: 1 },
    rrfScore: score,
    authorityLevel: authorityLevelOf(path.documentId),
  }
}

/** A canonical retrieved candidate: RTA s. 20(1), the landlord-repair duty. */
export const REPAIR_CANDIDATE = candidate(
  'rta-2006|part:III|section:20|subsection:1',
  'The landlord must keep the unit in a good state of repair.',
  0.91,
)

/** The cite that backs the repair claim (matches REPAIR_CANDIDATE.path). */
export const REPAIR_CITE: CitablePath = REPAIR_CANDIDATE.path

/** A void-clause candidate: a lease term that an Act section overrides. */
export const VOID_CLAUSE_CANDIDATE = candidate(
  'fixture-lease|section:7',
  'Tenant pays for all damage to the unit however caused.',
  0.84,
)

/**
 * The deterministic default rewrite the scripted fake's `reformulate` applies:
 * a recognizable, pure transform of the question (no network) so a test can
 * assert the SECOND retrieve pass saw the rewritten query, not the original.
 */
export function defaultReformulation(question: string): string {
  return `${question} (reformulated)`
}

/**
 * Options for the scripted fake: each decision is fixed, and `synthesize`
 * returns a fixed raw envelope JSON (optionally streamed token-by-token).
 */
export interface ScriptedModelOptions {
  readonly guard?: GuardDecision
  /** A queue of plans returned in order across plan() calls; last one repeats. */
  readonly plans?: readonly RetrievalPlan[]
  /** A queue of raw synthesis outputs returned in order; last one repeats. */
  readonly synthesisOutputs?: readonly string[]
  /** A queue of critic decisions returned in order; last one repeats. */
  readonly critiques?: readonly CriticDecision[]
  /**
   * The reformulation strategy the fake applies (#53). A pure function of the
   * original question so the rewrite is deterministic and offline; defaults to
   * {@link defaultReformulation} (appends a recognizable marker).
   */
  readonly reformulate?: (question: string) => string
  /** Stream the synthesis output in this many chunks (default 1, whole string). */
  readonly streamChunks?: number
}

/** The input the scripted model last saw at `synthesize` — recorded for #17 assertions. */
export type ScriptedSynthesizeInput = Parameters<AgentModel['synthesize']>[0]

/** A call-counting scripted model plus the counters the tests assert on. */
export interface ScriptedModel extends AgentModel {
  readonly calls: {
    guard: number
    plan: number
    synthesize: number
    critique: number
    reformulate: number
  }
  /** The most recent `synthesize` input (for asserting #17 memory pass-through). */
  lastSynthesizeInput?: ScriptedSynthesizeInput
}

const PASS_GUARD: GuardDecision = {
  verdict: 'pass',
  injectionDetected: false,
  reason: 'in scope',
}

const SINGLE_HOP_PLAN: RetrievalPlan = {
  hops: [{ query: 'landlord repair duty' }],
  multiHop: false,
}

const ANSWER_OUTPUT = JSON.stringify({
  behaviorClass: 'answer',
  answer: 'The landlord must keep the unit in a good state of repair.',
  claims: [
    {
      text: 'The landlord must keep the unit in a good state of repair.',
      cites: [
        {
          documentId: 'rta-2006',
          segments: [
            { kind: 'part', label: 'III' },
            { kind: 'section', label: '20' },
            { kind: 'subsection', label: '1' },
          ],
        },
      ],
    },
  ],
})

const GROUNDED_CRITIC: CriticDecision = { grounded: true, ungroundedClaims: [] }

/** Pick element `i` from a queue, repeating the last; throws on an empty queue. */
function at<T>(queue: readonly T[], i: number): T {
  if (queue.length === 0) throw new Error('scripted queue is empty')
  return queue[Math.min(i, queue.length - 1)]!
}

/** Split a string into `n` roughly-equal chunks for streaming. */
function chunk(text: string, n: number): string[] {
  if (n <= 1) return [text]
  const size = Math.ceil(text.length / n)
  const parts: string[] = []
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size))
  return parts
}

/** Build a scripted fake model with sensible answer-path defaults. */
export function scriptedModel(options: ScriptedModelOptions = {}): ScriptedModel {
  const guard = options.guard ?? PASS_GUARD
  const plans = options.plans ?? [SINGLE_HOP_PLAN]
  const synthesisOutputs = options.synthesisOutputs ?? [ANSWER_OUTPUT]
  const critiques = options.critiques ?? [GROUNDED_CRITIC]
  const reformulate = options.reformulate ?? defaultReformulation
  const streamChunks = options.streamChunks ?? 1
  const calls = { guard: 0, plan: 0, synthesize: 0, critique: 0, reformulate: 0 }

  const model: ScriptedModel = {
    calls,
    async guard() {
      calls.guard += 1
      return guard
    },
    async plan() {
      const out = at(plans, calls.plan)
      calls.plan += 1
      return out
    },
    async synthesize(input) {
      model.lastSynthesizeInput = input
      const out = at(synthesisOutputs, calls.synthesize)
      calls.synthesize += 1
      if (input.onToken) for (const token of chunk(out, streamChunks)) input.onToken(token)
      return out
    },
    async critique() {
      const out = at(critiques, calls.critique)
      calls.critique += 1
      return out
    },
    async reformulate({ question }) {
      calls.reformulate += 1
      return reformulate(question)
    },
  }
  return model
}
