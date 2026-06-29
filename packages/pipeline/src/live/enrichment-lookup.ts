/**
 * The expansion-target lookup the live enrichment access resolves through (#16).
 *
 * One-hop graph expansion ({@link import('../graph-expansion.js').expandOneHop})
 * follows a cross-reference edge to its far endpoint and calls
 * `lookup(citablePathKey)` to turn that endpoint's path key into a candidate. The
 * live serve binding resolves it from the SAME chunk store the agent retrieves
 * over (so expansion can only ever surface a chunk the corpus actually contains —
 * the anti-hallucination guard #13 enforces on the producer side, mirrored here),
 * but the projection and the map are PURE, so they are unit-tested offline against
 * in-memory rows and the live store list-read stays the only untested seam.
 *
 * A resolved target reaches expansion having NOT been retrieved by the query
 * (seeds are filtered out before lookup), so it carries no query-time fusion
 * provenance: zero fused score and no per-stage rank. `expandOneHop` then retags
 * it `graph-expansion` and spreads the rest — so the projected row must already
 * carry every {@link HybridCandidate} field (notably the parsed `path` the grader
 * needs and the `authorityLevel` rerank reads), or a missing field would crash
 * deep in synthesis instead of at this seam.
 */

import { authorityLevelOf } from '../authority.js'
import { type EnrichmentCandidateLookup } from './agent-enrichment.js'
import { type HybridCandidate } from '../hybrid-retrieve.js'
import { type ChunkRow } from './mongo-store.js'
import { parsePathKey } from '../retrieve.js'

/**
 * Project a stored {@link ChunkRow} to a {@link HybridCandidate} fit for an
 * expansion target. The structured `path` and the `authorityLevel` are DERIVED
 * the same way hybrid retrieval derives them (`parsePathKey` /
 * `authorityLevelOf`), so an expanded candidate is indistinguishable from a
 * retrieved one to the grader and rerank — except for its provenance, which is
 * graph-expansion-only by construction (zero fused score, no stage rank).
 */
export function chunkRowToHybridCandidate(row: ChunkRow): HybridCandidate {
  const path = parsePathKey(row.citablePathKey)
  return {
    documentId: row.documentId,
    citablePathKey: row.citablePathKey,
    path,
    text: row.text,
    // Graph expansion ALONE surfaced this row; it was never ranked by a query
    // stage, so a non-zero score / stage rank would mislabel its provenance and
    // corrupt the per-stage rescue stats (#16, graph-expansion.ts asGraphExpansion).
    score: 0,
    stage: 'graph-expansion',
    stages: ['graph-expansion'],
    stageRanks: {},
    rrfScore: 0,
    authorityLevel: authorityLevelOf(row.documentId),
  }
}

/**
 * Build the synchronous expansion-target lookup from the stored chunk rows: a
 * path-key → candidate map, projecting each row once. A present key resolves to
 * its candidate (a hit); an absent key returns `undefined` (a miss), so an edge
 * whose endpoint is not in the corpus is skipped by expansion rather than
 * synthesising a candidate. Sync, matching the {@link EnrichmentCandidateLookup}
 * contract.
 */
export function buildEnrichmentLookup(rows: readonly ChunkRow[]): EnrichmentCandidateLookup {
  const byKey = new Map<string, HybridCandidate>(
    rows.map((row) => [row.citablePathKey, chunkRowToHybridCandidate(row)]),
  )
  return (citablePathKey) => byKey.get(citablePathKey)
}
