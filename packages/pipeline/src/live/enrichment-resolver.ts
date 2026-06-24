/**
 * Gating resolver for the agent's query-time enrichment access (#16).
 *
 * `xrefExpansion` and `definitionsInPrompt` are DEFAULT-OFF A/B flags (ADR 0004:
 * flags flip at consumers). The persisted enrichment artifact is built offline by
 * a LIVE Claude pass (`enrich:build`, ADR 0005), so requiring it UNCONDITIONALLY
 * at serve start would force every off run — the default agent, the naive-rag and
 * stuff arms, the ablation's all-off floor rung, the smoke-gate's deployed service
 * — to have that artifact just to boot, and to fail without one. That is wrong:
 * flags off + no enrichment is the CORRECT, requested behaviour. The bug #16 fixes
 * is only "flags ON but enrichment silently absent" (the old `undefined` path).
 *
 * So this loads the artifact ONLY when a flag requests expansion or definitions;
 * otherwise it returns `undefined` and touches NEITHER injected seam (no file
 * read, no chunk-store read). When a flag IS on it loads, FAILS LOUD if the build
 * is for a different corpus (`assertEnrichmentBuildMatchesCorpus`), and projects
 * the chunk rows into the expansion-target lookup. Pure over its injected seams
 * (`loadArtifact` / `listChunks`), so the gating is unit-tested offline.
 */

import { type AgentEnrichmentAccess } from '../agent-types.js'
import { type AgentQueryFlags } from '../agent-query-flags.js'
import { createAgentEnrichmentAccess } from './agent-enrichment.js'
import { assertEnrichmentBuildMatchesCorpus } from './enrichment-build-guard.js'
import { type PersistedEnrichmentBuild } from './enrichment-artifact.js'
import { buildEnrichmentLookup } from './enrichment-lookup.js'
import { type ChunkRow } from './mongo-store.js'

/** The injected seams + identity the resolver gates the enrichment load behind. */
export interface ResolveAgentEnrichmentInput {
  /** The #16 query-time flags; the gate is `xrefExpansion || definitionsInPrompt`. */
  readonly flags: AgentQueryFlags
  /** Where the persisted artifact lives (passed to `loadArtifact` when a flag is on). */
  readonly artifactPath: string
  /** The corpus build hash serve is answering over (the fail-loud reconciliation target). */
  readonly corpusBuildHash: string
  /** Reads + validates the persisted artifact (live: file read; tests: a fake). */
  readonly loadArtifact: (path: string) => Promise<PersistedEnrichmentBuild>
  /** Reads the stored chunk rows the expansion-target lookup projects (live: Atlas). */
  readonly listChunks: () => Promise<readonly ChunkRow[]>
}

/** True when a #16 flag actually needs the enrichment sidecars at query time. */
function enrichmentRequested(flags: AgentQueryFlags): boolean {
  return flags.xrefExpansion || flags.definitionsInPrompt
}

/**
 * Resolve the agent's enrichment access, gated on the flags. Returns `undefined`
 * (calling neither seam) when no flag requests it — the default off-state, which
 * must not require the live-built artifact to exist. When a flag IS on: load +
 * validate the artifact, fail loud on a corpus mismatch, and return an access
 * whose lookup resolves expansion targets from the loaded chunk rows. A
 * flags-on-but-missing artifact still fails loud — the injected `loadArtifact`
 * throws and the rejection propagates (the chunk read is never reached).
 */
export async function resolveAgentEnrichment(
  input: ResolveAgentEnrichmentInput,
): Promise<AgentEnrichmentAccess | undefined> {
  if (!enrichmentRequested(input.flags)) {
    return undefined
  }
  const build = await input.loadArtifact(input.artifactPath)
  assertEnrichmentBuildMatchesCorpus({
    artifactCorpusBuildHash: build.corpusBuildHash,
    corpusBuildHash: input.corpusBuildHash,
  })
  const lookup = buildEnrichmentLookup(await input.listChunks())
  return createAgentEnrichmentAccess({ trees: build.trees, lookup })
}
