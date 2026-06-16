/**
 * The Owner profile (#17) — Mongo-persisted facts about the user's OWN situation
 * (unit, building, policy identifiers) injected as context ACROSS sessions
 * (CONTEXT.md, "Owner profile"). DISTINCT from session memory (the bounded
 * conversation summary): the profile is durable, cross-session, set-once facts;
 * session memory is a per-conversation rolling summary. The two never merge —
 * they flow through the API and into the agent graph as separate channels and
 * surface as separate trace spans.
 *
 * This module is pure and provider-free: the typed fact schema, the mockable
 * {@link ProfileStore} seam (mirrors the `mongo-store.ts` shape so the live
 * binding is swapped for a fake in unit tests — issue #17: "unit tests with a
 * mocked store; no real personal data in fixtures"), and the prompt renderer
 * that surfaces the facts to synthesis. The live Mongo binding lives in
 * `live/profile-session-store.ts`, never imported by the unit suite.
 */

import { z } from 'zod'

/**
 * The canonical owner-fact keys (CONTEXT.md, "Owner profile": unit, building,
 * policy identifiers). A closed set — `.strict()` below rejects anything else so
 * the profile can never become a dumping ground for arbitrary personal data.
 */
export const OWNER_PROFILE_FACT_KEYS = ['unit', 'building', 'policyNumber'] as const

export type OwnerProfileFactKey = (typeof OWNER_PROFILE_FACT_KEYS)[number]

/** The owner's situational facts — every key optional, so a sparse profile is valid. */
export const ownerProfileFactsSchema = z
  .object({
    /** The owner's unit identifier (e.g. "Unit 1203"). */
    unit: z.string().min(1).optional(),
    /** The building / corporation identifier (e.g. "YCC-42, 12 Maple Crescent"). */
    building: z.string().min(1).optional(),
    /** The owner's insurance policy identifier. */
    policyNumber: z.string().min(1).optional(),
  })
  .strict()

export type OwnerProfileFacts = z.infer<typeof ownerProfileFactsSchema>

/** A persisted owner profile: the owner id it is keyed by plus their facts. */
export const ownerProfileSchema = z
  .object({
    /** The stable key the profile is stored and retrieved under. */
    ownerId: z.string().min(1),
    /** The owner's situational facts (see {@link ownerProfileFactsSchema}). */
    facts: ownerProfileFactsSchema,
  })
  .strict()

export type OwnerProfile = z.infer<typeof ownerProfileSchema>

/** Validate an untyped value into an {@link OwnerProfile}. */
export function parseOwnerProfile(value: unknown): OwnerProfile {
  return ownerProfileSchema.parse(value)
}

/**
 * The persistence seam for owner profiles — the mockable store interface the
 * agent reads through (mirrors `MongoStore` in `mongo-store.ts`). The live
 * binding talks to Mongo; tests inject an in-memory fake, so cross-session
 * persistence is verified without a cluster and with no real personal data.
 */
export interface ProfileStore {
  /** Load the profile for an owner, or `undefined` if none is stored. */
  load(ownerId: string): Promise<OwnerProfile | undefined>
  /** Persist (upsert) a profile, keyed by its owner id. */
  save(profile: OwnerProfile): Promise<void>
}

/** Human-facing labels for each fact, in canonical render order. */
const FACT_LABELS: ReadonlyArray<readonly [OwnerProfileFactKey, string]> = [
  ['unit', 'Unit'],
  ['building', 'Building'],
  ['policyNumber', 'Insurance policy'],
]

/**
 * Render the owner profile as a labelled context block for the synthesis prompt
 * — so an answer can be grounded in the owner's OWN situation (their unit,
 * building, policy) across sessions. Returns the empty string for an absent or
 * fact-less profile: the documented off-state fallback, so a run with no profile
 * adds nothing to the prompt and stays byte-identical to the no-profile baseline.
 */
export function renderOwnerProfileContext(profile: OwnerProfile | undefined): string {
  if (!profile) return ''
  const lines = FACT_LABELS.flatMap(([key, label]) => {
    const value = profile.facts[key]
    return value ? [`- ${label}: ${value}`] : []
  })
  if (lines.length === 0) return ''
  return `OWNER PROFILE (the person asking — their own unit, building, and policy):\n${lines.join('\n')}`
}
