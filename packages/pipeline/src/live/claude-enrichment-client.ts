/**
 * The LIVE Claude client for the offline enrichment build (#16), routed through
 * `claude -p --output-format json` (ADR 0005: ingestion enrichment runs Claude
 * via the Agent SDK / `claude -p`, billed to the Max subscription credit; ADR
 * 0008 pins the same `claude -p` JSON wire the offline judge uses).
 *
 * This MIRRORS the Python judge adapter (`evals/.../judge_live.py`): one
 * subprocess per request, `--output-format json` so the model's `result` is read
 * off the CLI envelope, a per-call timeout, and a bounded retry that FAILS LOUD
 * rather than returning a malformed completion the enrichment parser would then
 * reject downstream. It adapts that wire to the enrichment `ClaudeClient` shape
 * (`{ system, user } → { text }`): the pass instruction rides `--system-prompt`,
 * the batched document is the prompt on stdin, and the model is pinned (never
 * hardcoded — read from the caller, which sources it from pipeline config).
 *
 * LIVE BY DESIGN and NOT unit-tested — exactly like `ingest-cli.ts` and the
 * Python judge's subprocess: the enrichment decisions (batching, caching, the
 * anti-hallucination path checks, the JSON-shape parsing) are all covered upstream
 * against `fakeClaudeClient`. Only the subprocess + envelope read live here, and
 * they only run where the `claude` login exists (the owner's machine / a
 * self-hosted runner), never in stock CI.
 */

import { spawn } from 'node:child_process'

import {
  type ClaudeClient,
  type ClaudeRequest,
  type ClaudeResponse,
} from '@owners-manual/enrichment'

/** Per-request wall-clock budget for one `claude -p` enrichment call (mirrors ADR 0008). */
const ENRICH_TIMEOUT_MS = 120_000

/** Attempts per request before failing loud (ADR 0008: bounded retry, then throw). */
const ENRICH_MAX_ATTEMPTS = 2

/** The raw result of running `claude -p`: exit status plus captured stdout/stderr. */
interface ClaudeCliResult {
  readonly status: number | null
  readonly timedOut: boolean
  readonly stdout: string
  readonly stderr: string
}

/** Runs the `claude` CLI with the given argv + stdin, resolving its result. Injectable. */
export type ClaudeCliRunner = (
  argv: readonly string[],
  stdin: string,
  timeoutMs: number,
) => Promise<ClaudeCliResult>

/**
 * The production runner: spawns `claude` with a fixed argv (the prompt arrives on
 * stdin, never as a flag, so a hostile-looking document can't be read as an
 * option), buffers stdout/stderr, and kills the process on timeout so a hung call
 * never blocks the build indefinitely.
 */
export const spawnClaudeCli: ClaudeCliRunner = (argv, stdin, timeoutMs) =>
  new Promise<ClaudeCliResult>((resolve, reject) => {
    const child = spawn('claude', [...argv], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        status: code,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })

    child.stdin.on('error', () => {
      // A stdin EPIPE means the child already exited; the close handler reports it.
    })
    child.stdin.end(stdin)
  })

/**
 * Parse the `claude -p --output-format json` envelope, returning the model's
 * `result` text. Throws — descriptively — on malformed JSON, an error envelope
 * (`is_error`), or a missing/non-string `result`: an enrichment pass that
 * proceeded on a failed CLI call would feed garbage to the validating parser
 * (mirrors the judge's `parse_judge_cli_envelope`, ADR 0008).
 */
export function parseClaudeCliResult(stdout: string): string {
  let envelope: unknown
  try {
    envelope = JSON.parse(stdout)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`claude CLI did not return valid JSON: ${reason}`)
  }
  if (typeof envelope !== 'object' || envelope === null) {
    throw new Error('claude CLI envelope is not a JSON object')
  }
  const record = envelope as Record<string, unknown>
  if (record.is_error) {
    throw new Error(`claude CLI reported an error: ${JSON.stringify(record.result)}`)
  }
  if (typeof record.result !== 'string') {
    throw new Error("claude CLI envelope has no string 'result' field")
  }
  return record.result
}

/** Construction options for the live enrichment client. */
export interface ClaudeEnrichmentClientOptions {
  /** The pinned enrichment model (from pipeline config; recorded in the build hash). */
  readonly model: string
  /** The CLI runner; defaults to {@link spawnClaudeCli}. Injectable so the shape is reviewable. */
  readonly runner?: ClaudeCliRunner
  /** Per-request timeout in ms; defaults to {@link ENRICH_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Attempts before failing loud; defaults to {@link ENRICH_MAX_ATTEMPTS}. */
  readonly maxAttempts?: number
}

/**
 * Build the live {@link ClaudeClient} over `claude -p`. The model string is
 * required and pinned by the caller (pipeline config), never hardcoded — a
 * mislabeled enrichment model would mint a build whose hash claims one model but
 * was produced by another (`runEnrichmentBuild` asserts the client model matches
 * the config). Each completion is one `claude -p` call: the pass `system` rides
 * `--system-prompt`, the batched `user` document is the prompt on stdin, and the
 * envelope's `result` is the response text the enrichment parser validates.
 */
export function createClaudeEnrichmentClient(options: ClaudeEnrichmentClientOptions): ClaudeClient {
  if (!options.model.trim()) {
    throw new Error('createClaudeEnrichmentClient requires a non-empty model string')
  }
  const runner = options.runner ?? spawnClaudeCli
  const timeoutMs = options.timeoutMs ?? ENRICH_TIMEOUT_MS
  const maxAttempts = options.maxAttempts ?? ENRICH_MAX_ATTEMPTS

  const complete = async (request: ClaudeRequest): Promise<ClaudeResponse> => {
    const argv = [
      '-p',
      '--model',
      options.model,
      '--system-prompt',
      request.system,
      '--output-format',
      'json',
    ]
    let lastError: Error | undefined
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const result = await runner(argv, request.user, timeoutMs)
        if (result.timedOut) {
          throw new Error(`claude CLI timed out after ${timeoutMs}ms`)
        }
        if (result.status !== 0) {
          const detail = result.stderr.trim() || `exit ${result.status}`
          throw new Error(`claude CLI exited non-zero: ${detail}`)
        }
        return { text: parseClaudeCliResult(result.stdout) }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
      }
    }
    throw new Error(
      `claude enrichment client failed after ${maxAttempts} attempts: ${lastError?.message}`,
    )
  }

  return { model: options.model, complete }
}
