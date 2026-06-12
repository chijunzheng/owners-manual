/**
 * `providers:verify` entry point (issue #6): one cheap live call per provider,
 * rendered as a PASS/FAIL table. Reads the repo-root .env (gitignored) if
 * present; never prints a secret — failure messages are scrubbed in verify.ts.
 *
 * The model strings below are PROBE-ONLY pins (cheapest viable call). Runtime
 * model pins live in pipeline config (#10) and hash into builds — not here.
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ChatVertexAI, VertexAIEmbeddings } from '@langchain/google-vertexai'
import { MongoClient } from 'mongodb'

import {
  formatResultsTable,
  runVerification,
  verificationExitCode,
  type ProviderProbes,
} from './verify.js'

const PROBE_GEMINI_MODEL = 'gemini-2.5-flash'
const PROBE_EMBEDDING_MODEL = 'gemini-embedding-001'
const PROBE_VOYAGE_MODEL = 'voyage-law-2'
const PROBE_COHERE_MODEL = 'rerank-v3.5'

const FETCH_TIMEOUT_MS = 15_000
const MONGO_TIMEOUT_MS = 8_000

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..', '..')

/** Load the repo-root .env into process.env; absent file is fine (CI). */
function loadRootEnv(): void {
  try {
    process.loadEnvFile(join(repoRoot, '.env'))
  } catch {
    // No .env yet — checks will report which vars are missing.
  }
}

async function postJson(url: string, apiKey: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    const text = (await response.text()).slice(0, 120)
    throw new Error(`HTTP ${response.status}: ${text}`)
  }
  return response.json()
}

const liveProbes: ProviderProbes = {
  async atlasPing(uri, db) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: MONGO_TIMEOUT_MS })
    try {
      await client.connect()
      await client.db(db).command({ ping: 1 })
      return `connected; ping ok (db: ${db})`
    } finally {
      await client.close()
    }
  },

  async geminiGenerate(_project, location) {
    // Project resolves from GOOGLE_CLOUD_PROJECT via ADC (keyless impersonated
    // SA — see .env.example); only the location is passed explicitly.
    const model = new ChatVertexAI({ model: PROBE_GEMINI_MODEL, location, maxRetries: 1 })
    const reply = await model.invoke('Reply with exactly: ok')
    const length = typeof reply.content === 'string' ? reply.content.length : 0
    return `generate ok (${PROBE_GEMINI_MODEL}, ${length}-char reply)`
  },

  async geminiEmbed(_project, location) {
    const embeddings = new VertexAIEmbeddings({
      model: PROBE_EMBEDDING_MODEL,
      location,
      maxRetries: 1,
    })
    const vector = await embeddings.embedQuery('owners-manual provider verify')
    return `${PROBE_EMBEDDING_MODEL} ok (${vector.length}-dim vector at location "${location}")`
  },

  async voyageEmbed(apiKey) {
    const data = (await postJson('https://api.voyageai.com/v1/embeddings', apiKey, {
      model: PROBE_VOYAGE_MODEL,
      input: ['owners-manual provider verify'],
    })) as { data?: ReadonlyArray<{ embedding?: readonly number[] }> }
    const dims = data.data?.[0]?.embedding?.length ?? 0
    if (dims === 0) throw new Error('embedding response contained no vector')
    return `${PROBE_VOYAGE_MODEL} ok (${dims}-dim vector)`
  },

  async cohereRerank(apiKey) {
    const data = (await postJson('https://api.cohere.com/v2/rerank', apiKey, {
      model: PROBE_COHERE_MODEL,
      query: 'who repairs the unit?',
      documents: ['The landlord must maintain the rental unit.', 'Parking is assigned by lot.'],
      top_n: 1,
    })) as { results?: readonly unknown[] }
    if (!data.results || data.results.length === 0) {
      throw new Error('rerank response contained no results')
    }
    return `${PROBE_COHERE_MODEL} ok (reranked 2 documents)`
  },

  async langfuseHealth(host) {
    const response = await fetch(`${host}/api/public/health`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${host} — is the stack up? (infra/langfuse)`)
    }
    const body = (await response.json()) as { status?: string; version?: string }
    return `${body.status ?? 'OK'} v${body.version ?? '?'}`
  },
}

loadRootEnv()
const results = await runVerification(process.env, liveProbes)
process.stdout.write(`${formatResultsTable(results)}\n`)
process.exitCode = verificationExitCode(results)
