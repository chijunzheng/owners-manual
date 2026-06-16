/**
 * Repo-root .env loading + typed config resolution for the live CLIs (ingest,
 * serve). Mirrors the providers-package pattern: read the gitignored .env into
 * process.env, then resolve the few vars this arm needs, failing loud on absent
 * required secrets. Never echoes a secret value.
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo root, four levels up from packages/pipeline/src/live/. */
const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..')

/** Repo-root path for a repo-relative file (HTML inputs, manifest). */
export function repoPath(...segments: string[]): string {
  return join(repoRoot, ...segments)
}

/** Load the repo-root .env into process.env; absent file is fine (CI). */
export function loadRootEnv(): void {
  try {
    process.loadEnvFile(join(repoRoot, '.env'))
  } catch {
    // No .env — required-var resolution below reports what's missing.
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is not set — copy .env.example to .env and fill it in`)
  }
  return value
}

/** The resolved runtime config the live CLIs share. */
export interface LiveConfig {
  readonly mongoUri: string
  readonly mongoDb: string
  readonly voyageApiKey: string
  readonly vertexLocation: string
}

/** Resolve the live config from process.env, defaulting non-secrets. */
export function resolveLiveConfig(): LiveConfig {
  return {
    mongoUri: required('MONGODB_URI'),
    mongoDb: process.env.MONGODB_DB?.trim() || 'owners_manual',
    voyageApiKey: required('VOYAGE_API_KEY'),
    vertexLocation: process.env.GOOGLE_CLOUD_LOCATION?.trim() || 'global',
  }
}

const PLACEHOLDER = /PLACEHOLDER|CHANGEME/i

/**
 * The Cohere Rerank API key, or `undefined` when unset or still a placeholder
 * (#16 rerank A/B). Optional by design: with no usable key the rerank-provider
 * selector degrades the `cohere` arm to the deterministic authority reranker
 * rather than failing — a missing key pins the deterministic arm, never breaks a
 * run. Never echoes the value.
 */
export function resolveCohereApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.COHERE_API_KEY?.trim()
  if (!key || PLACEHOLDER.test(key)) return undefined
  return key
}

/**
 * True when Langfuse tracing is usable: both keys present and not placeholders,
 * and not explicitly disabled via NAIVE_RAG_NO_LANGFUSE. When false the service
 * runs without harness-side trace export rather than spamming 401s — the
 * propagation contract (the service reuses the request's trace id) is unaffected.
 */
export function langfuseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NAIVE_RAG_NO_LANGFUSE === '1') return false
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim()
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim()
  if (!publicKey || !secretKey) return false
  return !PLACEHOLDER.test(`${publicKey}${secretKey}`)
}
