/**
 * The live Mongo binding for the two #17 memory mechanisms (ADR 0002 — the owner
 * profile and session memory live "in the same database as the structured
 * collections"). Connects to the `owners_manual` database and exposes a
 * {@link ProfileStore} over an `owner_profiles` collection and a
 * {@link SessionMemoryStore} over a `session_memory` collection, each keyed by
 * its id and upserted.
 *
 * Mirrors `mongo-store.ts`: a typed store interface plus a `connect*Store`
 * function over the verified `mongodb` driver, so the unit suite mocks the store
 * (`ProfileStore` / `SessionMemoryStore`) rather than the driver — issue #17:
 * "unit tests with a mocked store; no real personal data in fixtures". This thin
 * glue is exercised by the serve CLI, not the unit suite (the store contracts,
 * the bounded summarization, and the cross-session injection are unit-tested
 * against in-memory fakes in `owner-profile` / `session-memory` / `chat-service`).
 * Stored values are validated through the same zod schemas on read, so a row
 * that drifted from the schema fails loud rather than entering a prompt.
 */

import { MongoClient } from 'mongodb'

import { parseOwnerProfile, type OwnerProfile, type ProfileStore } from '../owner-profile.js'
import {
  parseSessionMemory,
  type SessionMemory,
  type SessionMemoryStore,
} from '../session-memory.js'

export interface ProfileSessionStoreOptions {
  readonly uri: string
  readonly db: string
  /** The owner-profiles collection name (default `owner_profiles`). */
  readonly profileCollection?: string
  /** The session-memory collection name (default `session_memory`). */
  readonly sessionCollection?: string
}

/** The two #17 stores plus the shared connection's `close`. */
export interface ProfileSessionStore {
  readonly profiles: ProfileStore
  readonly sessions: SessionMemoryStore
  /** Close the underlying connection. */
  close(): Promise<void>
}

const DEFAULT_PROFILE_COLLECTION = 'owner_profiles'
const DEFAULT_SESSION_COLLECTION = 'session_memory'

/** Connect and return the {@link ProfileSessionStore} over both collections. */
export async function connectProfileSessionStore(
  options: ProfileSessionStoreOptions,
): Promise<ProfileSessionStore> {
  const client = new MongoClient(options.uri, { serverSelectionTimeoutMS: 10_000 })
  await client.connect()
  const database = client.db(options.db)
  const profileCollection = database.collection<OwnerProfile>(
    options.profileCollection ?? DEFAULT_PROFILE_COLLECTION,
  )
  const sessionCollection = database.collection<SessionMemory>(
    options.sessionCollection ?? DEFAULT_SESSION_COLLECTION,
  )

  const profiles: ProfileStore = {
    async load(ownerId) {
      const row = await profileCollection.findOne({ ownerId }, { projection: { _id: 0 } })
      // Validate on read — a drifted row fails loud rather than seeding a prompt.
      return row ? parseOwnerProfile(row) : undefined
    },
    async save(profile) {
      const validated = parseOwnerProfile(profile)
      await profileCollection.replaceOne({ ownerId: validated.ownerId }, validated, {
        upsert: true,
      })
    },
  }

  const sessions: SessionMemoryStore = {
    async load(sessionId) {
      const row = await sessionCollection.findOne({ sessionId }, { projection: { _id: 0 } })
      return row ? parseSessionMemory(row) : undefined
    },
    async save(memory) {
      const validated = parseSessionMemory(memory)
      await sessionCollection.replaceOne({ sessionId: validated.sessionId }, validated, {
        upsert: true,
      })
    },
  }

  return { profiles, sessions, close: () => client.close() }
}
