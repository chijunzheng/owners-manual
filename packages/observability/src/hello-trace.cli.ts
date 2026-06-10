#!/usr/bin/env node
/**
 * CLI wrapper around {@link emitHelloTrace}: run `pnpm --filter
 * @owners-manual/observability hello-trace` (after copying .env) to push one
 * trace to the local Langfuse UI and print its id + a deep link.
 */
import { emitHelloTrace } from './hello-trace.js'

async function main(): Promise<void> {
  const { traceId, host } = await emitHelloTrace()
  // eslint-disable-next-line no-console -- CLI user output, not library logging
  console.log(
    `Emitted TS hello trace ${traceId} to ${host}\n` +
      `View it at ${host}/project (open the project, then Tracing -> Traces and filter for "owners-manual.hello-trace.ts").`,
  )
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console -- surface the failure to the CLI user
  console.error('hello-trace failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
