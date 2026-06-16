/**
 * The live query-time enrichment-access binding (#16): adapts #13's produced
 * tree-level sidecars (the {@link EnrichmentBuild} from `runEnrichmentBuild` —
 * the cross-reference graph + definitions index, keyed to tree hash) into the
 * {@link AgentEnrichmentAccess} seam the agent's retrieve node reads through.
 *
 * Read-only by construction (ADR 0004: flags flip at consumers, never producers):
 * this never re-runs an enrichment pass, it only projects the already-built
 * sidecars for the documents a query touched. The candidate-lookup an expansion
 * target resolves through is injected — the live serve binding resolves it from
 * the same Atlas chunk store the agent retrieves over (deferred to the live-run
 * milestone alongside live hybrid-arm ingestion, exactly like the `/stuff`
 * context-cache lifecycle), tests inject an in-memory map.
 *
 * LIVE BY DESIGN and not unit-tested — the expansion, the definitions match, the
 * flag gating, and the provenance tagging are all covered upstream against fakes;
 * this is the thin adapter, mirroring `createAgentRetrieve`.
 */

import {
  type CrossReferenceEdge,
  type DefinitionsIndex,
  type TreeEnrichment,
} from '@owners-manual/enrichment'

import { type AgentEnrichmentAccess } from '../agent-types.js'
import { type HybridCandidate } from '../hybrid-retrieve.js'

/** Resolve an expansion target's path key to a candidate row (live: chunk store). */
export type EnrichmentCandidateLookup = (citablePathKey: string) => HybridCandidate | undefined

export interface AgentEnrichmentDeps {
  /** The produced tree-level sidecars (one per document), from #13's build. */
  readonly trees: readonly TreeEnrichment[]
  /** Resolve an expansion target's path key to a candidate row. */
  readonly lookup: EnrichmentCandidateLookup
}

/** The documentId a stored path key belongs to (the key's first `|`-segment). */
function documentIdOf(citablePathKey: string): string {
  return citablePathKey.split('|', 1)[0] ?? ''
}

/**
 * Build an {@link AgentEnrichmentAccess} from the produced sidecars. The xref
 * edges and definitions exposed for a candidate set are restricted to the
 * documents those candidates belong to — one-hop expansion stays within a
 * document's own cross-reference graph, and definitions come from the documents
 * actually retrieved (never the whole corpus's definition table).
 */
export function createAgentEnrichmentAccess(deps: AgentEnrichmentDeps): AgentEnrichmentAccess {
  const treesByDocument = new Map(deps.trees.map((tree) => [tree.documentId, tree]))

  const documentIdsOf = (candidates: readonly HybridCandidate[]): Set<string> =>
    new Set(candidates.map((c) => documentIdOf(c.citablePathKey)))

  return {
    crossReferencesFor(candidates): readonly CrossReferenceEdge[] {
      const documents = documentIdsOf(candidates)
      const edges: CrossReferenceEdge[] = []
      for (const documentId of documents) {
        const tree = treesByDocument.get(documentId)
        if (tree) edges.push(...tree.crossReferences)
      }
      return edges
    },
    definitionsFor(candidates): DefinitionsIndex {
      const documents = documentIdsOf(candidates)
      const merged: Record<string, string> = {}
      for (const documentId of documents) {
        const tree = treesByDocument.get(documentId)
        if (tree) Object.assign(merged, tree.definitions)
      }
      return merged
    },
    lookup: deps.lookup,
  }
}
