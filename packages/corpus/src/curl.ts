/**
 * curl-backed byte source.
 *
 * Why curl and not Node's `fetch`: ontario.ca's `/laws/` pages sit behind a WAF
 * that serves the full server-rendered statute HTML to a real browser/curl but
 * hands undici (`fetch`) a per-request, unstable React shell that does not
 * contain the statute text. curl reliably retrieves the reproducible document,
 * so it is the transport for a live rebuild. The runner is injected so unit
 * tests never spawn a process and CI never reaches the network.
 */

import { spawn } from 'node:child_process'

import type { ByteSource } from './verify.js'

/** Result of running curl: exit status plus captured stdout/stderr bytes. */
export interface CurlResult {
  readonly status: number
  readonly stdout: Uint8Array
  readonly stderr: Uint8Array
}

/** Runs curl with the given argv and resolves its result. Injectable for tests. */
export type CurlRunner = (args: readonly string[]) => Promise<CurlResult>

/**
 * Builds curl arguments for a single GET: silent but error-reporting, follows
 * redirects, fails the process on an HTTP error so a 404/500 is a nonzero exit,
 * and guards the URL behind `--` so a hostile-looking URL can't be read as a
 * flag.
 */
export function buildCurlArgs(url: string): readonly string[] {
  return ['--silent', '--show-error', '--location', '--fail', '--', url]
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).trim()
}

/** The production {@link CurlRunner}: spawns the system `curl`, buffering output. */
export const spawnCurl: CurlRunner = (args) =>
  new Promise<CurlResult>((resolve, reject) => {
    const child = spawn('curl', [...args])
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      resolve({
        status: code ?? 0,
        stdout: new Uint8Array(Buffer.concat(stdout)),
        stderr: new Uint8Array(Buffer.concat(stderr)),
      })
    })
  })

/** A {@link ByteSource} that fetches each source via curl. */
export function curlByteSource(runner: CurlRunner = spawnCurl): ByteSource {
  return {
    read: async (source) => {
      let result: CurlResult
      try {
        result = await runner(buildCurlArgs(source.url))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`Failed to run curl for ${source.url}: ${reason}`)
      }

      if (result.status !== 0) {
        const detail = decode(result.stderr) || `curl exited ${result.status}`
        throw new Error(`Fetch of ${source.url} failed (curl exit ${result.status}): ${detail}`)
      }

      return result.stdout
    },
  }
}
