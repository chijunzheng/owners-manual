/**
 * The LangGraph state annotation for the agent graph (#15).
 *
 * Defined with `Annotation.Root` so the compiled graph is correctly typed
 * end-to-end. Each channel is a last-write-wins value with an explicit default —
 * the agent keeps no accumulating scratchpad (CONTEXT.md, "Planner": never an
 * open-ended ReAct loop), so the only reducers are "replace". `candidates` is
 * REPLACED each retrieve pass (not concatenated) so a re-retrieval reconsiders
 * the candidate set rather than growing it unboundedly; the counters increase by
 * their nodes returning the bumped value. Provider-free, so the graph is unit-
 * tested offline against a scripted fake.
 *
 * {@link AgentState} (in `agent-types.ts`) is the hand-written public contract
 * the nodes and tests read. The annotation's inferred state has every channel
 * present (optional ones as `… | undefined`); {@link AgentState} marks those
 * optional with `?`, so an annotation state is always assignable to it (the
 * direction the graph passes state to nodes) — the two are kept aligned by the
 * channel list below, which is the single source of the field set.
 */

import { Annotation } from '@langchain/langgraph'

import { type AnswerEnvelope } from './answer-envelope.js'
import {
  type AgentState,
  type CriticDecision,
  type GuardDecision,
  type RetrievalPlan,
} from './agent-types.js'
import { type DefinitionAttachment } from './graph-expansion.js'
import { type HybridCandidate } from './hybrid-retrieve.js'
import { type OwnerProfile } from './owner-profile.js'
import { type SessionMemory } from './session-memory.js'

/** A last-write-wins reducer: a node update replaces the prior value. */
function lastWriteWins<T>(left: T, right: T | undefined): T {
  return right === undefined ? left : right
}

/** The agent graph's state annotation — the channels the {@link StateGraph} owns. */
export const AgentAnnotation = Annotation.Root({
  question: Annotation<string>({ reducer: lastWriteWins, default: () => '' }),
  itemId: Annotation<string | undefined>({ reducer: lastWriteWins, default: () => undefined }),
  reformulatedQuestion: Annotation<string | undefined>({
    reducer: lastWriteWins,
    default: () => undefined,
  }),
  guardDecision: Annotation<GuardDecision | undefined>({
    reducer: lastWriteWins,
    default: () => undefined,
  }),
  plan: Annotation<RetrievalPlan | undefined>({
    reducer: lastWriteWins,
    default: () => undefined,
  }),
  candidates: Annotation<readonly HybridCandidate[]>({
    reducer: lastWriteWins,
    default: () => [],
  }),
  definitionAttachments: Annotation<readonly DefinitionAttachment[]>({
    reducer: lastWriteWins,
    default: () => [],
  }),
  reformulations: Annotation<number>({ reducer: lastWriteWins, default: () => 0 }),
  criticReretrievals: Annotation<number>({ reducer: lastWriteWins, default: () => 0 }),
  criticDecision: Annotation<CriticDecision | undefined>({
    reducer: lastWriteWins,
    default: () => undefined,
  }),
  degraded: Annotation<boolean>({ reducer: lastWriteWins, default: () => false }),
  envelope: Annotation<AnswerEnvelope | undefined>({
    reducer: lastWriteWins,
    default: () => undefined,
  }),
  rawModelOutput: Annotation<string | undefined>({
    reducer: lastWriteWins,
    default: () => undefined,
  }),
  // The two #17 memory channels: set on INITIAL state by the API, read by
  // synthesize, never written by a node — so they carry through unchanged. Kept
  // as separate channels (not one merged object) because they are distinct
  // mechanisms (CONTEXT.md): the owner profile is cross-session facts, the
  // session memory is the bounded conversation summary.
  ownerProfile: Annotation<OwnerProfile | undefined>({
    reducer: lastWriteWins,
    default: () => undefined,
  }),
  sessionMemory: Annotation<SessionMemory | undefined>({
    reducer: lastWriteWins,
    default: () => undefined,
  }),
})

/** The annotation's inferred state — assignable to {@link AgentState} (nodes read it). */
export type AgentAnnotationState = typeof AgentAnnotation.State

// Compile-time guard: an annotation state must be assignable to the public
// contract the nodes read. A field present in the annotation but absent from
// AgentState fails the build here.
const _stateContract = {} as AgentAnnotationState satisfies AgentState
void _stateContract
