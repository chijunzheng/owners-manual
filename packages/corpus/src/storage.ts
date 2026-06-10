/**
 * Filesystem I/O for the corpus tooling: loading the manifest, and reading or
 * writing raw source bytes under corpus/raw/.
 *
 * `file` paths come from the committed manifest, but they are still resolved
 * defensively against the raw root so a malformed entry can never write outside
 * the corpus directory. Raw bytes themselves stay gitignored (Crown copyright);
 * only the manifest and this script are committed.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { parseManifest } from './manifest/schema.js'
import type { Manifest, ManifestSource } from './manifest/schema.js'
import type { ByteSource } from './verify.js'

/** Loads and validates the manifest JSON at `path`. */
export async function loadManifest(path: string): Promise<Manifest> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not read corpus manifest at ${path}: ${reason}`)
  }

  const json: unknown = JSON.parse(text)
  return parseManifest(json)
}

/**
 * Resolves a source's `file` to an absolute path inside `rawRoot`, throwing if
 * the entry would escape the root (path traversal or absolute path).
 */
function resolveWithinRoot(rawRoot: string, file: string): string {
  if (isAbsolute(file)) {
    throw new Error(`Source file path must be relative, got absolute "${file}"`)
  }
  const root = resolve(rawRoot)
  const target = resolve(root, file)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Source file path "${file}" resolves outside the raw root`)
  }
  return target
}

/** Writes a source's bytes to `rawRoot/<file>`, creating parent dirs. */
export async function writeSource(
  rawRoot: string,
  source: ManifestSource,
  bytes: Uint8Array,
): Promise<void> {
  const target = resolveWithinRoot(rawRoot, source.file)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
}

/**
 * A {@link ByteSource} backed by already-fetched files under `rawRoot`. Used to
 * re-verify a checkout without hitting the network.
 */
export function diskByteSource(rawRoot: string): ByteSource {
  return {
    read: async (source) => {
      const target = resolveWithinRoot(rawRoot, source.file)
      try {
        const buffer = await readFile(target)
        return new Uint8Array(buffer)
      } catch {
        throw new Error(
          `${join(rawRoot, source.file)} has not been fetched yet — run the fetch command first`,
        )
      }
    },
  }
}
