#!/usr/bin/env node
/**
 * `corpus:fetch` entry point.
 *
 * Default mode fetches every source in the manifest, verifies its checksum, and
 * writes the verified bytes to corpus/raw/. `--verify-only` skips the network
 * and re-checks the bytes already on disk — that is the mode CI and a clean
 * checkout use to assert a byte-identical rebuild without redistributing Crown
 * copyright text or making a request.
 *
 * The exit code is the contract: 0 when every source matches, nonzero on any
 * mismatch, fetch error, or bad manifest, with a clear report on stderr.
 *
 * `run` is dependency-injected and pure of process state so it can be unit
 * tested; the executable footer is the only place that touches real stdout,
 * the network, and process.exit.
 */

import { pathToFileURL } from 'node:url'

import { curlByteSource } from './curl.js'
import { rebuild } from './rebuild.js'
import { renderReport } from './report.js'
import { loadManifest, diskByteSource } from './storage.js'
import { verifyManifest } from './verify.js'
import type { ByteSource } from './verify.js'

/** Default location of the committed manifest, relative to the repo root. */
export const DEFAULT_MANIFEST = 'corpus/manifest.json'
/** Default location of the gitignored raw corpus, relative to the repo root. */
export const DEFAULT_RAW_ROOT = 'corpus/raw'

/** Injectable side effects so `run` stays testable. */
export interface CliDeps {
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Factory for the live network byte source (only invoked outside verify-only). */
  networkSource: () => ByteSource
}

/** Parsed command-line options. */
export interface CliOptions {
  readonly manifestPath: string
  readonly rawRoot: string
  readonly verifyOnly: boolean
}

/** Parses argv (without node/script) into {@link CliOptions}. */
export function parseArgs(argv: readonly string[]): CliOptions {
  let manifestPath = DEFAULT_MANIFEST
  let rawRoot = DEFAULT_RAW_ROOT
  let verifyOnly = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--verify-only':
        verifyOnly = true
        break
      case '--manifest': {
        const value = argv[i + 1]
        if (value === undefined) throw new Error('--manifest requires a path argument')
        manifestPath = value
        i += 1
        break
      }
      case '--raw': {
        const value = argv[i + 1]
        if (value === undefined) throw new Error('--raw requires a path argument')
        rawRoot = value
        i += 1
        break
      }
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return { manifestPath, rawRoot, verifyOnly }
}

/**
 * Runs the fetch/verify pipeline and returns the process exit code (0 ok, 1
 * fail). Never throws for an expected failure (bad manifest, mismatch); those
 * are reported and mapped to exit code 1.
 */
export async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  let options: CliOptions
  try {
    options = parseArgs(argv)
  } catch (error) {
    deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  let report
  try {
    const manifest = await loadManifest(options.manifestPath)
    report = options.verifyOnly
      ? await verifyManifest(manifest, diskByteSource(options.rawRoot))
      : await rebuild(manifest, deps.networkSource(), options.rawRoot)
  } catch (error) {
    deps.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  const rendered = `${renderReport(report)}\n`
  if (report.ok) {
    deps.stdout(rendered)
    return 0
  }
  deps.stderr(rendered)
  return 1
}

/* c8 ignore start -- executable wiring; the pure `run` above carries the tests */
const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href

if (isMain) {
  const deps: CliDeps = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    networkSource: () => curlByteSource(),
  }
  run(process.argv.slice(2), deps)
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
      process.exitCode = 1
    })
}
/* c8 ignore stop */
