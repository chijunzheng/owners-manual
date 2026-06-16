/**
 * One-hop cross-reference expansion + definitions attachment (#16) — the
 * QUERY-TIME consumers of #13's tree-level sidecars (the cross-reference graph
 * and the definitions index).
 *
 * Both are pure mechanism, provider-free, and unit-tested offline (the flag
 * gating that decides WHETHER they run lives in the retrieve node, behind
 * `AgentQueryFlags`; this module is what runs when the flag is on). Expansion is
 * BOUNDED to exactly one hop (CONTEXT.md, "Planner": all iteration is explicit
 * bounded edges — never an open traversal). Every candidate pulled in by
 * expansion is tagged `graph-expansion` so the dashboard can report which
 * required cites graph expansion ALONE rescued (the mechanism-not-outcome stat).
 *
 * The candidate-resolution seam ({@link CandidateByPathKey}) is injected so this
 * module never knows about the chunk store: tests resolve from an in-memory map,
 * the live binding resolves from the same Atlas collection the agent retrieves
 * over. An edge whose endpoint does not resolve is skipped — expansion can never
 * synthesise a candidate the corpus does not contain (mirrors the anti-
 * hallucination guard #13's enrichment already enforces on the producer side).
 */

import { type CrossReferenceEdge, type DefinitionsIndex } from '@owners-manual/enrichment'

import { type HybridCandidate } from './hybrid-retrieve.js'

/** Resolve a citable-path key to its candidate row, or `undefined` if absent. */
export type CandidateByPathKey = (citablePathKey: string) => HybridCandidate | undefined

/** The inputs to one-hop expansion: the seed candidates, the graph, the lookup. */
export interface ExpandOneHopInput {
  /** The candidates retrieval already surfaced — the expansion seeds. */
  readonly seeds: readonly HybridCandidate[]
  /** The document's cross-reference edges (#13's xref sidecar). */
  readonly crossReferences: readonly CrossReferenceEdge[]
  /** Resolve an expansion target's path key to a candidate row. */
  readonly lookup: CandidateByPathKey
}

/** Tag a resolved expansion target with `graph-expansion` provenance ONLY.
 *
 * A target reaching here was NOT in the retrieved set (seeds are skipped above),
 * so the looked-up row's stored vector/bm25 provenance is irrelevant to THIS
 * query — graph expansion ALONE surfaced it. Carrying only `graph-expansion`
 * keeps the per-stage rescue stats honest: otherwise a cite reached solely by
 * expansion would look multi-stage, and `build_rescue_stats` would never credit
 * graph expansion as its SOLE rescuer — the exact ablation metric #16 produces.
 * [Codex P1, PR #52] */
function asGraphExpansion(target: HybridCandidate): HybridCandidate {
  return { ...target, stage: 'graph-expansion', stages: ['graph-expansion' as const] }
}

/**
 * Expand a candidate set one hop over the cross-reference graph. For every seed,
 * follow each edge that touches it (in EITHER direction — a reference to a seed is
 * as relevant as one from it) to the other endpoint, resolve that endpoint to a
 * candidate, and append it tagged `graph-expansion`. The seeds are preserved with
 * their original provenance; a target that was already a seed is NOT re-tagged or
 * duplicated. Bounded to one hop: targets are never themselves expanded.
 */
export function expandOneHop(input: ExpandOneHopInput): readonly HybridCandidate[] {
  const { seeds, crossReferences, lookup } = input
  const present = new Set(seeds.map((c) => c.citablePathKey))
  const seedKeys = new Set(present)

  const added: HybridCandidate[] = []
  for (const edge of crossReferences) {
    // An edge contributes a target only when exactly one endpoint is a seed; the
    // OTHER endpoint is the one-hop neighbour to pull in.
    for (const [endpoint, neighbour] of [
      [edge.from, edge.to],
      [edge.to, edge.from],
    ] as const) {
      if (!seedKeys.has(endpoint)) continue
      if (present.has(neighbour)) continue
      const resolved = lookup(neighbour)
      if (!resolved) continue
      present.add(neighbour)
      added.push(asGraphExpansion(resolved))
    }
  }

  return [...seeds, ...added]
}

/** One attached definition: the defined term and the path-key that defines it. */
export interface DefinitionAttachment {
  readonly term: string
  readonly definedAtPathKey: string
}

/** The inputs to definitions attachment: the candidates and the definitions index. */
export interface AttachDefinitionsInput {
  readonly candidates: readonly HybridCandidate[]
  /** The document's defined-term → defining-path index (#13's definitions sidecar). */
  readonly definitions: DefinitionsIndex
}

/**
 * Select the definitions to attach to synthesis: every defined term that any
 * candidate's text mentions (case-insensitive whole-text contains), de-duplicated
 * by term. The synthesizer then has the authoritative definition's location for a
 * term it is about to reason over — without re-authoring it. Pure; never mutates.
 */
export function attachDefinitions(input: AttachDefinitionsInput): readonly DefinitionAttachment[] {
  const { candidates, definitions } = input
  const haystack = candidates.map((c) => c.text.toLowerCase())
  const attachments: DefinitionAttachment[] = []
  for (const [term, definedAtPathKey] of Object.entries(definitions)) {
    const needle = term.toLowerCase()
    if (haystack.some((text) => text.includes(needle))) {
      attachments.push({ term, definedAtPathKey })
    }
  }
  return attachments
}
