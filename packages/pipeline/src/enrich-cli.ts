/**
 * `enrich:build` — the one-time offline enrichment build for the agent arm (#16).
 * Parses the golden-v0 corpus, runs #13's tree- and chunk-level enrichment over
 * every document through the LIVE Claude client (`claude -p`, ADR 0005), and
 * PERSISTS the tree-level sidecars (plus the build identity) to a gitignored JSON
 * artifact that `naive-rag:serve` loads to power the agent's query-time graph
 * expansion + definitions attachment.
 *
 * Live by design (sanctioned, cheap, offline batch): reads the gitignored
 * corpus/raw bytes, calls Claude under the subscription credit, writes a local
 * artifact. NOT exercised by vitest — every decision it composes (the build
 * wiring, the caches, the anti-hallucination path checks, the serialize/load
 * boundary) is unit-tested upstream against `fakeClaudeClient` and the pure
 * artifact suite. Mirrors `ingest-cli.ts`: thin orchestration, no logic of its own.
 *
 * The persisted `corpusBuildHash` is computed the SAME way `naive-rag:serve`
 * computes it (the shared `buildRunRecord` over the same manifest + fixture +
 * config inputs), so the serve-side guard can fail loud when the loaded sidecars
 * were built against a different corpus than the one being served.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { createMemoryCache, hierarchyChunker, runEnrichmentBuild } from '@owners-manual/enrichment'
import type { ParsedDocument } from '@owners-manual/parser'

import {
  GOLDEN_V0_DOCUMENTS,
  corpusSourceIds,
  loadCorpusForIngest,
  loadFixtureSnapshot,
} from './corpus-loader.js'
import { NAIVE_RAG_PIPELINE_CONFIG } from './pipeline-config.js'
import { buildRunRecord, type ManifestSnapshotSource } from './run-record.js'
import {
  serializeEnrichmentArtifact,
  type PersistedEnrichmentBuild,
} from './live/enrichment-artifact.js'
import { createClaudeEnrichmentClient } from './live/claude-enrichment-client.js'
import { ENRICHMENT_MODEL, ENRICHMENT_PIPELINE_CONFIG } from './live/enrichment-config.js'
import { loadRootEnv, repoPath } from './live/env.js'
import { loadManifestSnapshot } from './live/manifest-snapshot.js'

/** Where the persisted enrichment artifact lives (gitignored — see .gitignore). */
const ARTIFACT_PATH = repoPath('corpus', 'enrichment', 'build.json')

/**
 * The opaque manifest hash the enrichment build records (ADR 0004 keeps the
 * corpus package's manifest hashing decoupled — enrichment treats it as opaque).
 * A deterministic SHA-256 over the manifest snapshot the build measured, so the
 * enrichment `BuildMetadata` pins the same statute provenance the run record does.
 */
function hashManifestSnapshot(sources: readonly ManifestSnapshotSource[]): string {
  const canonical = sources.map((source) => [source.id, source.sha256, source.consolidationDate])
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex')
}

async function main(): Promise<number> {
  loadRootEnv()

  process.stdout.write('Parsing golden-v0 corpus (tenancy-only)…\n')
  const corpus = await loadCorpusForIngest({
    documents: GOLDEN_V0_DOCUMENTS,
    read: (relPath) => readFile(repoPath(relPath), 'utf8'),
  })
  const documents: readonly ParsedDocument[] = corpus.map((entry) => entry.parsed)

  // The manifest + fixture snapshots pin the corpus build hash — derived from the
  // SAME helper ingest and serve use, so the persisted corpusBuildHash matches the
  // one serve checks it against (Codex PR #72: one shared source set, never re-filtered).
  const manifestSources = await loadManifestSnapshot(
    repoPath('corpus', 'manifest.json'),
    corpusSourceIds(GOLDEN_V0_DOCUMENTS),
  )
  const fixtureSources = await loadFixtureSnapshot({
    documents: GOLDEN_V0_DOCUMENTS,
    read: (relPath) => readFile(repoPath(relPath), 'utf8'),
  })
  const runRecord = buildRunRecord({
    config: NAIVE_RAG_PIPELINE_CONFIG,
    manifestSources,
    fixtureSources,
    includedDocumentIds: corpus.map((entry) => entry.documentId),
  })

  // The live Claude client is built from the SAME pinned model the config records,
  // so runEnrichmentBuild's coherence assertion (client.model === config.enrichmentModel)
  // holds by construction rather than by a hand-kept duplicate string.
  process.stdout.write(`Enriching with ${ENRICHMENT_MODEL} via claude -p (ADR 0005)…\n`)
  const client = createClaudeEnrichmentClient({ model: ENRICHMENT_MODEL })

  const build = await runEnrichmentBuild({
    documents,
    manifestHash: hashManifestSnapshot(manifestSources),
    config: ENRICHMENT_PIPELINE_CONFIG,
    client,
    chunker: hierarchyChunker,
    caches: { tree: createMemoryCache<string>(), chunk: createMemoryCache<string>() },
  })

  // Persist the tree-level sidecars the agent reads, plus both build identities:
  // the enrichment metadata (provenance) and the serve-checked corpusBuildHash.
  const persisted: PersistedEnrichmentBuild = {
    corpusBuildHash: runRecord.corpusBuildHash,
    metadata: build.metadata,
    trees: build.trees,
  }
  await mkdir(dirname(ARTIFACT_PATH), { recursive: true })
  await writeFile(ARTIFACT_PATH, serializeEnrichmentArtifact(persisted), 'utf8')

  process.stdout.write(`\nWrote enrichment artifact to ${ARTIFACT_PATH}\n`)
  process.stdout.write(`  trees: ${build.trees.length} document sidecars\n`)
  process.stdout.write(`  enrichment build hash: ${build.metadata.buildHash}\n`)
  process.stdout.write(`  corpus build hash: ${runRecord.corpusBuildHash}\n`)
  return 0
}

process.exitCode = await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`enrich build failed: ${message}\n`)
  return 1
})
