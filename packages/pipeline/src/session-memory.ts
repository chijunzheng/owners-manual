/**
 * Session memory (#17) — the BOUNDED summary of one conversation, DISTINCT from
 * the Owner profile (CONTEXT.md flagged ambiguity: "session memory (summarized
 * history) vs Owner profile (cross-session facts) are distinct mechanisms").
 *
 * The defining property (issue #17 AC2) is that session memory stays BOUNDED:
 * it is a rolling SUMMARY, not a growing transcript. {@link appendTurn} folds
 * each new (question, answer) into the prior summary via an injected
 * {@link SessionSummarizer} and then HARD-CAPS the result at
 * {@link SESSION_SUMMARY_MAX_CHARS} — so total memory cost is bounded no matter
 * how many turns accumulate, and a misbehaving summarizer can never persist an
 * unbounded blob. The cap is enforced twice: the stored value is truncated, and
 * the schema rejects anything over the cap (defence in depth).
 *
 * Pure and provider-free: the summarizer is the only LLM-shaped call and it is
 * INJECTED, so the bound is unit-tested offline against a deterministic fake
 * (issue #17: "unit tests with a mocked store"). The live Mongo binding lives in
 * `live/profile-session-store.ts`; the live summarizer wraps the runtime model.
 */

import { z } from 'zod'

/**
 * The hard cap on a session summary, in characters. Session memory is a bounded
 * summary, so this ceiling is what makes memory cost flat in the number of turns
 * rather than linear — the heart of AC2 ("summarization, not transcript growth").
 */
export const SESSION_SUMMARY_MAX_CHARS = 2_000

/** A persisted conversation summary: keyed by session id, bounded, turn-counted. */
export const sessionMemorySchema = z
  .object({
    /** The stable key the summary is stored and retrieved under. */
    sessionId: z.string().min(1),
    /** The rolling conversation summary — never longer than the cap. */
    summary: z.string().max(SESSION_SUMMARY_MAX_CHARS),
    /** How many turns have been folded in (provenance; bounded summary is the payload). */
    turnCount: z.number().int().nonnegative(),
  })
  .strict()

export type SessionMemory = z.infer<typeof sessionMemorySchema>

/** Validate an untyped value into a {@link SessionMemory}. */
export function parseSessionMemory(value: unknown): SessionMemory {
  return sessionMemorySchema.parse(value)
}

/** A fresh, empty session — no summary yet, zero turns. */
export function emptySessionMemory(sessionId: string): SessionMemory {
  return { sessionId, summary: '', turnCount: 0 }
}

/**
 * The injected summarizer seam — the one LLM-shaped call in session memory.
 * Takes the prior bounded summary plus the new turn and returns the next
 * summary. INJECTED (the AgentModel pattern) so {@link appendTurn}'s bound is
 * unit-tested offline against a deterministic fake; the live binding wraps the
 * runtime model (ADR 0005) and prompts it to compress, never to transcribe.
 */
export type SessionSummarizer = (input: {
  readonly priorSummary: string
  readonly question: string
  readonly answer: string
}) => Promise<string>

/** Truncate to the cap on a whitespace boundary where possible (avoid mid-word cuts). */
function capSummary(summary: string): string {
  if (summary.length <= SESSION_SUMMARY_MAX_CHARS) return summary
  const sliced = summary.slice(0, SESSION_SUMMARY_MAX_CHARS)
  const lastSpace = sliced.lastIndexOf(' ')
  return lastSpace > SESSION_SUMMARY_MAX_CHARS * 0.5 ? sliced.slice(0, lastSpace) : sliced
}

/**
 * Fold one turn into the session summary and return a NEW {@link SessionMemory}
 * (immutable — the input is never mutated, per coding style). The injected
 * summarizer produces the next summary; the result is then HARD-CAPPED so the
 * stored summary can never exceed {@link SESSION_SUMMARY_MAX_CHARS} — the AC2
 * boundedness guarantee holds even if the summarizer ignores the bound. The
 * capped value is re-validated through the schema so an over-cap summary can
 * never be persisted.
 */
export async function appendTurn(
  memory: SessionMemory,
  input: {
    readonly question: string
    readonly answer: string
    readonly summarize: SessionSummarizer
  },
): Promise<SessionMemory> {
  const next = await input.summarize({
    priorSummary: memory.summary,
    question: input.question,
    answer: input.answer,
  })
  return parseSessionMemory({
    sessionId: memory.sessionId,
    summary: capSummary(next),
    turnCount: memory.turnCount + 1,
  })
}

/**
 * The persistence seam for session memory — the mockable store interface the
 * agent reads/writes through (mirrors `MongoStore` in `mongo-store.ts`). The
 * live binding talks to Mongo; tests inject an in-memory fake so the
 * load-summarize-save loop is verified without a cluster.
 */
export interface SessionMemoryStore {
  /** Load the summary for a session, or `undefined` if none is stored. */
  load(sessionId: string): Promise<SessionMemory | undefined>
  /** Persist (upsert) a session summary, keyed by its session id. */
  save(memory: SessionMemory): Promise<void>
}

/**
 * Render the session summary as a labelled context block for the synthesis
 * prompt — so a later turn answers in light of what the conversation already
 * covered. Returns the empty string for an absent or summary-less session: the
 * documented off-state fallback, so a fresh session adds nothing to the prompt.
 */
export function renderSessionMemoryContext(memory: SessionMemory | undefined): string {
  if (!memory || memory.summary.trim().length === 0) return ''
  return `CONVERSATION SO FAR (a summary of earlier turns this session):\n${memory.summary}`
}
