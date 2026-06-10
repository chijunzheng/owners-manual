/**
 * Hello-trace for the TypeScript Langfuse SDK: emits one visible trace against
 * the configured Langfuse instance and returns its id. Proves the product-side
 * (TS) tracing path is wired end-to-end before any agent code exists.
 */
import { Langfuse } from 'langfuse'

/** Default host: the local self-hosted Langfuse UI (Cloud is the env fallback). */
export const LOCAL_LANGFUSE_HOST = 'http://localhost:3000'

/** Stable trace name so the emitted trace is easy to find in the Langfuse UI. */
export const HELLO_TRACE_NAME = 'owners-manual.hello-trace.ts'

export interface HelloTraceResult {
  traceId: string
  host: string
}

/**
 * Resolve the Langfuse host from `LANGFUSE_HOST`, defaulting to the local
 * self-host. An empty or unset value falls back to {@link LOCAL_LANGFUSE_HOST}.
 */
export function resolveLangfuseHost(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.LANGFUSE_HOST?.trim()
  return host && host.length > 0 ? host : LOCAL_LANGFUSE_HOST
}

/**
 * Emit exactly one trace via the TS SDK and flush it to the server.
 *
 * Reads `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_HOST` from
 * the environment (see infra/langfuse/.env.example). Throws a clear error if
 * credentials are missing rather than silently no-op'ing.
 */
export async function emitHelloTrace(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HelloTraceResult> {
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim()
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim()

  if (!publicKey || !secretKey) {
    throw new Error(
      'LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set (copy infra/langfuse/.env.example to .env and fill in the project keys from the Langfuse UI).',
    )
  }

  const host = resolveLangfuseHost(env)
  const langfuse = new Langfuse({ publicKey, secretKey, baseUrl: host })

  const trace = langfuse.trace({
    name: HELLO_TRACE_NAME,
    input: { message: 'hello from the TypeScript SDK' },
    metadata: { source: 'hello-trace.ts', phase: 'phase-0', sdk: 'typescript' },
    tags: ['hello-trace', 'phase-0'],
  })

  const span = trace.span({ name: 'compose-the-greeting' })
  trace.update({ output: { greeting: 'hello, owners-manual' } })
  span.end()

  // Flush before resolving so the trace is durably sent even for a short-lived
  // process (the SDK batches in the background otherwise).
  await langfuse.flushAsync()

  return { traceId: trace.id, host }
}
