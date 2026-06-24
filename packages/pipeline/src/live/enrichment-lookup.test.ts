import { describe, expect, it } from 'vitest'

import { authorityLevelOf } from '../authority.js'
import { type ChunkRow } from './mongo-store.js'
import { parsePathKey } from '../retrieve.js'
import { buildEnrichmentLookup, chunkRowToHybridCandidate } from './enrichment-lookup.js'

/**
 * The PURE expansion-target lookup the live enrichment access resolves through
 * (#16). The agent's one-hop graph expansion calls `lookup(citablePathKey)` for
 * an edge's far endpoint; the live binding resolves it from the SAME chunk store
 * the agent retrieves over. `expandOneHop` retags a resolved row `graph-expansion`
 * and spreads the rest, so the projection must carry every {@link HybridCandidate}
 * field — a missing `path`/`authorityLevel` would surface as a grader/rerank crash
 * deep in synthesis, not at the seam.
 */

const REPAIR_KEY = 'rta-2006|part:III|section:20|subsection:1'
const NOTICE_KEY = 'rta-2006|section:12'

const row = (citablePathKey: string, text: string): ChunkRow => ({
  id: `hierarchy-v1:${citablePathKey}`,
  citablePathKey,
  text,
  documentId: citablePathKey.split('|', 1)[0]!,
  chunker: 'hierarchy-v1',
  embedding: [0.1, 0.2, 0.3],
})

const ROWS: readonly ChunkRow[] = [
  row(REPAIR_KEY, 'The landlord must keep the unit in a good state of repair.'),
  row(NOTICE_KEY, 'Despite section 2, a notice is valid if given in writing.'),
]

describe('chunkRowToHybridCandidate', () => {
  it('projects a stored row to a full hybrid candidate, deriving path and authority', () => {
    const candidate = chunkRowToHybridCandidate(ROWS[0]!)
    expect(candidate).toEqual({
      documentId: 'rta-2006',
      citablePathKey: REPAIR_KEY,
      path: parsePathKey(REPAIR_KEY),
      text: 'The landlord must keep the unit in a good state of repair.',
      score: 0,
      stage: 'graph-expansion',
      stages: ['graph-expansion'],
      stageRanks: {},
      rrfScore: 0,
      authorityLevel: authorityLevelOf('rta-2006'),
    })
  })

  it('carries no query-time fusion provenance — an expansion target was not retrieved', () => {
    const candidate = chunkRowToHybridCandidate(ROWS[0]!)
    // A target reaching the lookup was surfaced by graph expansion ALONE (the seeds
    // are skipped before lookup), so a non-zero fused score or a vector/bm25 rank
    // would mislabel its provenance and corrupt the per-stage rescue stats (#16).
    expect(candidate.score).toBe(0)
    expect(candidate.rrfScore).toBe(0)
    expect(candidate.stageRanks).toEqual({})
  })
})

describe('buildEnrichmentLookup', () => {
  it('resolves a present path key to its projected candidate (hit)', () => {
    const lookup = buildEnrichmentLookup(ROWS)
    const candidate = lookup(NOTICE_KEY)
    expect(candidate?.citablePathKey).toBe(NOTICE_KEY)
    expect(candidate?.text).toBe('Despite section 2, a notice is valid if given in writing.')
  })

  it('returns undefined for a path key the corpus does not contain (miss)', () => {
    const lookup = buildEnrichmentLookup(ROWS)
    expect(lookup('rta-2006|section:999')).toBeUndefined()
  })

  it('is synchronous — the AgentEnrichmentAccess lookup contract is sync', () => {
    const lookup = buildEnrichmentLookup(ROWS)
    const candidate = lookup(REPAIR_KEY)
    expect(candidate).not.toBeInstanceOf(Promise)
    expect(candidate?.citablePathKey).toBe(REPAIR_KEY)
  })
})
