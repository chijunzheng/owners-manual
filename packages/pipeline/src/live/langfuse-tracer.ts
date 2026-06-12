/**
 * The live Langfuse tracer (issue #10 AC2). Implements {@link NaiveRagTracer}
 * over the Langfuse TS SDK, creating each item's trace with the trace id
 * PROPAGATED from the Python harness so the service's spans share one trace with
 * the harness's experiment run — visible as a single nested trace in Langfuse.
 *
 * The Langfuse TS v3 SDK accepts an explicit trace `id`; when the harness passes
 * a 32-hex W3C trace id, the service reuses it verbatim, so the harness span and
 * the service spans collapse into one trace. Builds on the observability
 * package's host resolution; never echoes the secret key.
 */

import { resolveLangfuseHost } from '@owners-manual/observability'
import { Langfuse } from 'langfuse'

import { type NaiveRagTracer, type TraceHandle } from '../naive-rag.js'

export interface LangfuseTracerHandle {
  readonly tracer: NaiveRagTracer
  /** Flush buffered traces to the server (call before the response returns). */
  flush(): Promise<void>
  shutdown(): Promise<void>
}

/** Build a Langfuse-backed tracer from env credentials. */
export function createLangfuseTracer(env: NodeJS.ProcessEnv = process.env): LangfuseTracerHandle {
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim()
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim()
  if (!publicKey || !secretKey) {
    throw new Error('LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set for naive-rag tracing')
  }
  const host = resolveLangfuseHost(env)
  const langfuse = new Langfuse({ publicKey, secretKey, baseUrl: host })

  const tracer: NaiveRagTracer = {
    startTrace(options) {
      const trace = langfuse.trace({
        // Reuse the propagated id verbatim so harness + service share a trace.
        ...(options.traceId ? { id: options.traceId } : {}),
        name: options.name,
        input: options.input,
        metadata: options.metadata,
        tags: ['naive-rag', 'arm:naive-rag'],
      })
      const handle: TraceHandle = {
        span(name, input) {
          const span = trace.span({ name, input })
          return { end: () => span.end() }
        },
        setOutput(output) {
          trace.update({ output })
        },
      }
      return handle
    },
  }

  return {
    tracer,
    flush: () => langfuse.flushAsync(),
    shutdown: () => langfuse.shutdownAsync(),
  }
}
