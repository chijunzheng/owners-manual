import { describe, expect, it } from 'vitest'

import { type CrossReferenceEdge } from '@owners-manual/enrichment'

import { candidate } from './agent-fixtures.js'
import {
  attachDefinitions,
  expandOneHop,
  type CandidateByPathKey,
  type DefinitionAttachment,
} from './graph-expansion.js'
import { type HybridCandidate } from './hybrid-retrieve.js'

// One-hop cross-reference expansion (#16). Consumes #13's tree-level xref sidecar
// at query time, bounded to ONE hop, behind the `xrefExpansion` flag (the flag
// gating lives in the retrieve node; this module is the pure mechanism). Every
// pulled-in candidate is tagged `graph-expansion` so the dashboard can credit it.

/** A small fixture corpus the lookup seam resolves expansion targets from. */
const REPAIR = candidate(
  'rta-2006|part:III|section:20|subsection:1',
  'The landlord must keep the unit in a good state of repair.',
  0.91,
)
const DESPITE_TARGET = candidate(
  'rta-2006|part:III|section:30',
  'Despite section 20, the tenant may apply to the Board for an order.',
  0.4,
)
const SECOND_HOP = candidate(
  'rta-2006|part:III|section:40',
  'A further provision reachable only at the second hop.',
  0.3,
)

/** A lookup seam over the fixture corpus (the live binding hits the chunk store). */
function lookup(corpus: readonly HybridCandidate[]): CandidateByPathKey {
  const byKey = new Map(corpus.map((c) => [c.citablePathKey, c]))
  return (key: string) => byKey.get(key)
}

const EDGES: readonly CrossReferenceEdge[] = [
  { from: REPAIR.citablePathKey, to: DESPITE_TARGET.citablePathKey, kind: 'referenced-by' },
  // A second-hop edge that one-hop expansion MUST NOT follow.
  { from: DESPITE_TARGET.citablePathKey, to: SECOND_HOP.citablePathKey, kind: 'referenced-by' },
]

describe('expandOneHop — bounded cross-reference expansion', () => {
  it('pulls in the one-hop neighbour of a seed candidate, tagged graph-expansion', () => {
    const expanded = expandOneHop({
      seeds: [REPAIR],
      crossReferences: EDGES,
      lookup: lookup([REPAIR, DESPITE_TARGET, SECOND_HOP]),
    })
    const added = expanded.find((c) => c.citablePathKey === DESPITE_TARGET.citablePathKey)
    expect(added).toBeDefined()
    expect(added!.stage).toBe('graph-expansion')
    // ONLY graph-expansion provenance — NOT the looked-up row's stored vector/bm25
    // tags — so a cite reached solely by expansion is credited to graph expansion
    // ALONE in the per-stage rescue stats (Codex P1, PR #52).
    expect(added!.stages).toEqual(['graph-expansion'])
  })

  it('is bounded to ONE hop — never follows the neighbour of a neighbour', () => {
    const expanded = expandOneHop({
      seeds: [REPAIR],
      crossReferences: EDGES,
      lookup: lookup([REPAIR, DESPITE_TARGET, SECOND_HOP]),
    })
    expect(expanded.map((c) => c.citablePathKey)).not.toContain(SECOND_HOP.citablePathKey)
  })

  it('follows edges in BOTH directions (an xref to a seed pulls the other endpoint)', () => {
    // The graph is directed, but a reference FROM a neighbour TO a seed is just as
    // relevant — "despite s.20" cited by s.30 should pull s.30 in when s.20 is a seed.
    const reverseEdges: readonly CrossReferenceEdge[] = [
      { from: DESPITE_TARGET.citablePathKey, to: REPAIR.citablePathKey, kind: 'despite' },
    ]
    const expanded = expandOneHop({
      seeds: [REPAIR],
      crossReferences: reverseEdges,
      lookup: lookup([REPAIR, DESPITE_TARGET]),
    })
    expect(expanded.map((c) => c.citablePathKey)).toContain(DESPITE_TARGET.citablePathKey)
  })

  it('keeps the original seeds and never duplicates an already-present candidate', () => {
    const expanded = expandOneHop({
      seeds: [REPAIR, DESPITE_TARGET],
      crossReferences: EDGES,
      lookup: lookup([REPAIR, DESPITE_TARGET, SECOND_HOP]),
    })
    const keys = expanded.map((c) => c.citablePathKey)
    expect(keys).toContain(REPAIR.citablePathKey)
    // DESPITE_TARGET is both a seed AND an expansion target; it appears once, and
    // its original stage (not graph-expansion) is preserved since it was retrieved.
    expect(keys.filter((k) => k === DESPITE_TARGET.citablePathKey)).toHaveLength(1)
    const kept = expanded.find((c) => c.citablePathKey === DESPITE_TARGET.citablePathKey)
    expect(kept!.stage).toBe('hybrid')
  })

  it('skips an edge whose target is not resolvable in the corpus (no phantom candidate)', () => {
    const danglingEdge: readonly CrossReferenceEdge[] = [
      { from: REPAIR.citablePathKey, to: 'rta-2006|section:999', kind: 'referenced-by' },
    ]
    const expanded = expandOneHop({
      seeds: [REPAIR],
      crossReferences: danglingEdge,
      lookup: lookup([REPAIR]),
    })
    expect(expanded).toHaveLength(1)
    expect(expanded[0]!.citablePathKey).toBe(REPAIR.citablePathKey)
  })

  it('returns the seeds unchanged when the xref graph is empty', () => {
    const expanded = expandOneHop({
      seeds: [REPAIR],
      crossReferences: [],
      lookup: lookup([REPAIR]),
    })
    expect(expanded).toEqual([REPAIR])
  })
})

describe('attachDefinitions — definitions-index attachment', () => {
  it('attaches the definition of a term a candidate mentions', () => {
    const attachments: readonly DefinitionAttachment[] = attachDefinitions({
      candidates: [REPAIR],
      definitions: { 'good state of repair': 'rta-2006|part:I|section:2|clause:def' },
    })
    expect(attachments).toHaveLength(1)
    expect(attachments[0]!.term).toBe('good state of repair')
    expect(attachments[0]!.definedAtPathKey).toBe('rta-2006|part:I|section:2|clause:def')
  })

  it('attaches nothing when no candidate text mentions a defined term', () => {
    const attachments = attachDefinitions({
      candidates: [REPAIR],
      definitions: { 'standard unit': 'fixture-declaration|section:5' },
    })
    expect(attachments).toEqual([])
  })

  it('matches a defined term case-insensitively', () => {
    const attachments = attachDefinitions({
      candidates: [candidate('rta-2006|section:1', 'The TENANT may apply.', 0.5)],
      definitions: { tenant: 'rta-2006|part:I|section:2|clause:tenant' },
    })
    expect(attachments.map((a) => a.term)).toEqual(['tenant'])
  })

  it('de-duplicates a term defined once but mentioned by several candidates', () => {
    const attachments = attachDefinitions({
      candidates: [
        candidate('rta-2006|section:1', 'The tenant may apply.', 0.5),
        candidate('rta-2006|section:2', 'A tenant has rights.', 0.4),
      ],
      definitions: { tenant: 'rta-2006|part:I|section:2|clause:tenant' },
    })
    expect(attachments).toHaveLength(1)
  })
})
