/**
 * Provider verification (issue #6): runs one cheap, real call against every
 * provider the env contract names and reports PASS/FAIL/WARN/SKIP per check.
 *
 * The orchestration here is pure and probe-injected so it is fully testable
 * offline; the live network probes live in verify-cli.ts. Secrets are read
 * from the env by the probes themselves and are NEVER echoed: failure details
 * are sanitized against every secret value before rendering.
 */

/** Check ids in render order — the public contract of the verify table. */
export const PROVIDER_CHECK_IDS = [
  'atlas',
  'vertex-gemini',
  'vertex-embedding',
  'voyage',
  'cohere',
  'langfuse',
] as const

export type ProviderCheckId = (typeof PROVIDER_CHECK_IDS)[number]

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip'

export interface CheckResult {
  readonly id: ProviderCheckId
  readonly label: string
  readonly status: CheckStatus
  readonly required: boolean
  readonly detail: string
}

/** Env mapping (process.env-shaped; injectable for tests). */
export interface VerifyEnv {
  readonly [key: string]: string | undefined
}

/**
 * One probe per provider. Each returns a short, secret-free success detail
 * and throws on failure. Probes receive resolved config, never the raw env.
 */
export interface ProviderProbes {
  readonly atlasPing: (uri: string, db: string) => Promise<string>
  readonly geminiGenerate: (project: string, location: string) => Promise<string>
  readonly geminiEmbed: (project: string, location: string) => Promise<string>
  readonly voyageEmbed: (apiKey: string) => Promise<string>
  readonly cohereRerank: (apiKey: string) => Promise<string>
  readonly langfuseHealth: (host: string) => Promise<string>
}

/** Defaults mirrored in .env.example — change both together. */
export const DEFAULT_LANGFUSE_HOST = 'http://localhost:3000'
export const DEFAULT_VERTEX_LOCATION = 'global'
export const DEFAULT_MONGODB_DB = 'owners_manual'

/** Env vars whose values must never appear in rendered output. */
const SECRET_ENV_VARS = [
  'MONGODB_URI',
  'VOYAGE_API_KEY',
  'COHERE_API_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const

/** Committed example values are not credentials — treat them as unset. */
const PLACEHOLDER_PATTERN = /PLACEHOLDER|CHANGEME/i

const MAX_DETAIL_LENGTH = 200

/** Read a var, treating blank and placeholder values as absent. */
function readEnv(env: VerifyEnv, name: string): string | undefined {
  const value = env[name]?.trim()
  if (!value || PLACEHOLDER_PATTERN.test(value)) return undefined
  return value
}

/**
 * Every value that must be redacted from failure details: secret env values
 * plus the credential segments of the Mongo SRV string (an error message may
 * embed only the password, not the whole URI).
 */
function collectSecrets(env: VerifyEnv): readonly string[] {
  const fromVars = SECRET_ENV_VARS.map((name) => env[name]?.trim()).filter(
    (value): value is string => Boolean(value && value.length >= 4),
  )
  const uriCredentials = fromVars.flatMap((value) => {
    const match = /\/\/([^:/@]+):([^@]+)@/.exec(value)
    const user = match?.[1]
    const password = match?.[2]
    return user && password ? [user, password] : []
  })
  return [...fromVars, ...uriCredentials]
}

/** First line of an error, truncated and scrubbed of every secret value. */
function sanitizeDetail(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split('\n')[0] ?? ''
  const scrubbed = secrets.reduce(
    (text, secret) => text.replaceAll(secret, '[redacted]'),
    firstLine,
  )
  return scrubbed.length > MAX_DETAIL_LENGTH ? `${scrubbed.slice(0, MAX_DETAIL_LENGTH)}…` : scrubbed
}

interface CheckPlan {
  readonly id: ProviderCheckId
  readonly label: string
  readonly required: boolean
  /** Status to report when the probe throws (fail for required, warn for advisory). */
  readonly failureStatus: 'fail' | 'warn'
  /** Unset → the env vars listed here are missing; reported per missingStatus. */
  readonly run: (() => Promise<string>) | undefined
  readonly missingVars: readonly string[]
  /** Status when run is undefined: fail (required var) or skip (advisory). */
  readonly missingStatus: 'fail' | 'skip'
}

async function executeCheck(plan: CheckPlan, secrets: readonly string[]): Promise<CheckResult> {
  const base = { id: plan.id, label: plan.label, required: plan.required }
  if (!plan.run) {
    const vars = plan.missingVars.join(', ')
    const detail =
      plan.missingStatus === 'skip'
        ? `skipped: ${vars} not set`
        : `${vars} not set (or still a placeholder) — copy .env.example to .env and fill it in`
    return { ...base, status: plan.missingStatus, detail }
  }
  try {
    const detail = await plan.run()
    return { ...base, status: 'pass', detail }
  } catch (error) {
    return { ...base, status: plan.failureStatus, detail: sanitizeDetail(error, secrets) }
  }
}

/** Run every provider check against the given env via the given probes. */
export async function runVerification(
  env: VerifyEnv,
  probes: ProviderProbes,
): Promise<readonly CheckResult[]> {
  const secrets = collectSecrets(env)

  const mongoUri = readEnv(env, 'MONGODB_URI')
  const mongoDb = readEnv(env, 'MONGODB_DB') ?? DEFAULT_MONGODB_DB
  const project = readEnv(env, 'GOOGLE_CLOUD_PROJECT')
  const location = readEnv(env, 'GOOGLE_CLOUD_LOCATION') ?? DEFAULT_VERTEX_LOCATION
  const voyageKey = readEnv(env, 'VOYAGE_API_KEY')
  const cohereKey = readEnv(env, 'COHERE_API_KEY')
  const langfuseHost = readEnv(env, 'LANGFUSE_HOST') ?? DEFAULT_LANGFUSE_HOST

  const plans: readonly CheckPlan[] = [
    {
      id: 'atlas',
      label: 'MongoDB Atlas (M0)',
      required: true,
      failureStatus: 'fail',
      run: mongoUri ? () => probes.atlasPing(mongoUri, mongoDb) : undefined,
      missingVars: ['MONGODB_URI'],
      missingStatus: 'fail',
    },
    {
      id: 'vertex-gemini',
      label: 'Vertex AI: Gemini generate',
      required: true,
      failureStatus: 'fail',
      run: project ? () => probes.geminiGenerate(project, location) : undefined,
      missingVars: ['GOOGLE_CLOUD_PROJECT'],
      missingStatus: 'fail',
    },
    {
      id: 'vertex-embedding',
      label: 'Vertex AI: gemini-embedding (advisory)',
      required: false,
      failureStatus: 'warn',
      run: project ? () => probes.geminiEmbed(project, location) : undefined,
      missingVars: ['GOOGLE_CLOUD_PROJECT'],
      missingStatus: 'skip',
    },
    {
      id: 'voyage',
      label: 'Voyage AI embeddings',
      required: true,
      failureStatus: 'fail',
      run: voyageKey ? () => probes.voyageEmbed(voyageKey) : undefined,
      missingVars: ['VOYAGE_API_KEY'],
      missingStatus: 'fail',
    },
    {
      id: 'cohere',
      label: 'Cohere rerank',
      required: true,
      failureStatus: 'fail',
      run: cohereKey ? () => probes.cohereRerank(cohereKey) : undefined,
      missingVars: ['COHERE_API_KEY'],
      missingStatus: 'fail',
    },
    {
      id: 'langfuse',
      label: 'Langfuse health',
      required: true,
      failureStatus: 'fail',
      run: () => probes.langfuseHealth(langfuseHost),
      missingVars: [],
      missingStatus: 'fail',
    },
  ]

  return Promise.all(plans.map((plan) => executeCheck(plan, secrets)))
}

/** Nonzero exactly when a required check failed. */
export function verificationExitCode(results: readonly CheckResult[]): number {
  return results.some((r) => r.required && r.status === 'fail') ? 1 : 0
}

/** Aligned PASS/FAIL table plus a one-line summary; safe to print as-is. */
export function formatResultsTable(results: readonly CheckResult[]): string {
  const idWidth = Math.max(...results.map((r) => r.id.length))
  const labelWidth = Math.max(...results.map((r) => r.label.length))
  const rows = results.map(
    (r) =>
      `${r.status.toUpperCase().padEnd(4)}  ${r.id.padEnd(idWidth)}  ${r.label.padEnd(labelWidth)}  ${r.detail}`,
  )

  const count = (status: CheckStatus): number => results.filter((r) => r.status === status).length
  const failed = verificationExitCode(results) !== 0
  const verdict = failed
    ? 'required checks failed — fix .env and re-run'
    : 'environment contract verified'
  const summary = `${count('pass')} pass, ${count('fail')} fail, ${count('warn')} warn, ${count('skip')} skip — ${verdict}`

  return [...rows, '', summary].join('\n')
}
