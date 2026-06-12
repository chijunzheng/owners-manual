/**
 * The structured answer envelope — the shared output contract every eval arm
 * emits (CONTEXT.md: "the structured answer envelope makes behavior and cites
 * machine-checkable without a judge"; issue #10 AC3: "Answer envelope
 * schema-validated on every response").
 *
 * The envelope is deliberately minimal and deterministic to parse: a behavior
 * class drawn from the same five the golden set asserts, the human-facing answer
 * prose, and a list of claims each carrying the {@link CitablePath} pin-cites
 * that back it. Refusal classes carry an empty `claims` list — the asserted
 * behavior is the refusal itself, and the golden refusal items carry no required
 * cites. The cite shape is reused verbatim from `@owners-manual/core` so the
 * deterministic grader resolves answer cites with the identical matcher it uses
 * for required cites — one artifact, two consumers.
 */

import { citablePathSchema, type CitablePath } from '@owners-manual/core'
import { z } from 'zod'

/**
 * The five behavior classes a response can assert — identical to the golden
 * item's `behavior_class` set so behavior match is a string compare, not a
 * mapping. Pinned in canonical order.
 */
export const ANSWER_BEHAVIOR_CLASSES = [
  'answer',
  'refuse-jurisdiction',
  'refuse-out-of-scope',
  'refuse-advice-escalate',
  'flag-void-clause',
] as const

export type AnswerBehaviorClass = (typeof ANSWER_BEHAVIOR_CLASSES)[number]

/** One claim in an answer plus the pin-cites that back it. */
export const answerClaimSchema = z
  .object({
    /** The claim text — a single assertion the answer makes. */
    text: z.string(),
    /** The pin-cites backing this claim; resolved by the deterministic grader. */
    cites: z.array(citablePathSchema),
  })
  .strict()

export type AnswerClaim = z.infer<typeof answerClaimSchema>

/**
 * The full structured answer envelope. `.strict()` so a synthesis step that
 * invents an extra field fails validation rather than silently smuggling
 * unscored content past the grader.
 */
export const answerEnvelopeSchema = z
  .object({
    /** The behavior the system asserts — string-comparable to the golden item. */
    behaviorClass: z.enum(ANSWER_BEHAVIOR_CLASSES),
    /** The human-facing answer prose. */
    answer: z.string(),
    /** The claims and their cites; empty for refusals. */
    claims: z.array(answerClaimSchema),
  })
  .strict()

export type AnswerEnvelope = z.infer<typeof answerEnvelopeSchema>

/** Validate and normalize an untyped value into an {@link AnswerEnvelope}. */
export function parseAnswerEnvelope(value: unknown): AnswerEnvelope {
  return answerEnvelopeSchema.parse(value)
}

/** Every cite across every claim, flattened — the candidate set for grading. */
export function candidateCites(envelope: AnswerEnvelope): readonly CitablePath[] {
  return envelope.claims.flatMap((claim) => claim.cites)
}
