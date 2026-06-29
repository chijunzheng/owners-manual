/**
 * Thin live reader for the persisted enrichment artifact (#16) — reads the
 * gitignored JSON the `enrich:build` CLI wrote and hands it to the PURE,
 * schema-validating {@link loadEnrichmentArtifact}. Kept separate from that pure
 * parser (and unit-tested only there) exactly like `manifest-snapshot.ts` sits
 * beside `manifest-snapshot-util.ts`: the file read is the only untested seam.
 *
 * A missing artifact is a MISCONFIGURATION surfaced loud at serve start, not a
 * silent fallback to the off-state: serve now depends on the enrichment build, so
 * an absent file says "run `enrich:build` first" rather than letting the agent's
 * graph-expansion / definitions flags fall back to no-ops while toggled on.
 */

import { readFile } from 'node:fs/promises'

import { loadEnrichmentArtifact, type PersistedEnrichmentBuild } from './enrichment-artifact.js'

/**
 * Read and validate the persisted enrichment artifact at `path`. Throws a
 * descriptive, fail-loud error naming the path (and the build step) when the file
 * is absent or unreadable; delegates malformed-content rejection to the pure
 * loader's schema validation.
 */
export async function loadEnrichmentArtifactFile(path: string): Promise<PersistedEnrichmentBuild> {
  let json: string
  try {
    json = await readFile(path, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `enrichment artifact not found at ${path} (${reason}). ` +
        'Run `pnpm --filter @owners-manual/pipeline enrich:build` against the current corpus first.',
    )
  }
  return loadEnrichmentArtifact(json)
}
