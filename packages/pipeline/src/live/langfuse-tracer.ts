/**
 * The live Langfuse tracer (issue #10 AC2). Implements {@link NaiveRagTracer}
 * over the Langfuse TS SDK so the service's spans share one trace with the
 * Python harness — and, when the harness propagates its span id via the W3C
 * `traceparent` header, NEST under that span as true children.
 *
 * Two modes, decided per item by what the harness propagated:
 *
 * - trace id + parent span id → the harness OWNS the trace; the service only
 *   creates a root span (`parentObservationId` = the harness span) plus stage
 *   child spans. It never upserts trace-level fields it doesn't own.
 * - trace id only (or nothing) → the service creates the trace itself with the
 *   propagated id (or a fresh one), as before.
 *
 * The Langfuse client is injectable (structural {@link LangfuseLikeClient}) so
 * the nesting decisions are unit-tested offline; the default binds the real
 * SDK. Builds on the observability package's host resolution; never echoes the
 * secret key.
 */

import { resolveLangfuseHost } from '@owners-manual/observability'
import { Langfuse } from 'langfuse'

import { type NaiveRagTracer, type TraceHandle } from '../naive-rag.js'

/** The slice of a Langfuse span/observation client the tracer uses. */
export interface LangfuseLikeSpan {
  span(options: { name: string; input?: unknown }): LangfuseLikeSpan
  update(fields: { output?: unknown }): unknown
  end(): unknown
}

/** The slice of a Langfuse trace client the tracer uses. */
export interface LangfuseLikeTrace {
  span(options: { name: string; input?: unknown }): LangfuseLikeSpan
  update(fields: { output?: unknown }): unknown
}

/** The slice of the Langfuse SDK client the tracer uses — injectable in tests. */
export interface LangfuseLikeClient {
  trace(options: {
    id?: string
    name: string
    input?: unknown
    metadata?: Record<string, unknown>
    tags?: string[]
  }): LangfuseLikeTrace
  span(options: {
    traceId: string
    parentObservationId: string
    name: string
    input?: unknown
    metadata?: Record<string, unknown>
  }): LangfuseLikeSpan
  flushAsync(): Promise<unknown>
  shutdownAsync(): Promise<unknown>
}

export interface LangfuseTracerHandle {
  readonly tracer: NaiveRagTracer
  /** Flush buffered traces to the server (call before the response returns). */
  flush(): Promise<void>
  shutdown(): Promise<void>
}

const TAGS = ['naive-rag', 'arm:naive-rag']

/** Build a Langfuse-backed tracer from env credentials. */
export function createLangfuseTracer(
  env: NodeJS.ProcessEnv = process.env,
  client?: LangfuseLikeClient,
): LangfuseTracerHandle {
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim()
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim()
  if (!publicKey || !secretKey) {
    throw new Error('LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set for naive-rag tracing')
  }
  const host = resolveLangfuseHost(env)
  const langfuse: LangfuseLikeClient =
    client ?? (new Langfuse({ publicKey, secretKey, baseUrl: host }) as LangfuseLikeClient)

  const tracer: NaiveRagTracer = {
    startTrace(options) {
      // Nested mode: the harness owns the trace — attach a service root span
      // under the harness's span and put every stage span beneath it.
      if (options.traceId && options.parentSpanId) {
        const serviceRoot = langfuse.span({
          traceId: options.traceId,
          parentObservationId: options.parentSpanId,
          name: options.name,
          input: options.input,
          metadata: options.metadata,
        })
        const handle: TraceHandle = {
          span(name, input) {
            const span = serviceRoot.span({ name, input })
            return { end: () => span.end() }
          },
          setOutput(output) {
            serviceRoot.update({ output })
            serviceRoot.end()
          },
        }
        return handle
      }

      // Root mode: no harness span — the service creates (or adopts) the trace.
      const trace = langfuse.trace({
        // Reuse the propagated id verbatim so harness + service share a trace.
        ...(options.traceId ? { id: options.traceId } : {}),
        name: options.name,
        input: options.input,
        metadata: options.metadata,
        tags: TAGS,
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
    flush: () => langfuse.flushAsync().then(() => undefined),
    shutdown: () => langfuse.shutdownAsync().then(() => undefined),
  }
}
