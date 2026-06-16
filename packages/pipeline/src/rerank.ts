/**
 * The rerank providers and the rerank-survivor provenance (#16).
 *
 * #16 makes reranking an A/B behind a flag: authority-weighted (deterministic,
 * provider-free) vs Cohere Rerank vs LLM-rerank. All three satisfy the injected
 * {@link AgentRerank} seam (the AgentModel/AgentRetrieve pattern), so the rerank
 * node calls one opaque reranker and the unit tests drive a SCRIPTED FAKE — never
 * a live Cohere/Vertex call. The live `cohere`/`llm` bindings live under `live/`;
 * this module owns the deterministic `authority` provider, the scripted fake, and
 * the survivor-tagging every provider shares.
 *
 * `tagRerankSurvivors` is the mechanism half of "component value as MECHANISM"
 * (CONTEXT.md, "Retrieval hit rate"): a candidate the reranker keeps carries the
 * `rerank-survivor` tag, so the dashboard can report which required cites the
 * reranker promoted into the answerable window — not just whether the answer got
 * better. Tagging is idempotent and order-preserving so the provenance is stable.
 */

import { type AgentRerank } from './agent-types.js'
import { rerankByAuthority } from './agent-nodes.js'
import { type HybridCandidate } from './hybrid-retrieve.js'

/** Add `rerank-survivor` to a candidate's stages (idempotent, sorted). */
function withSurvivorTag(candidate: HybridCandidate): HybridCandidate {
  if (candidate.stages.includes('rerank-survivor')) return candidate
  const stages = [...candidate.stages, 'rerank-survivor' as const].sort()
  return { ...candidate, stages }
}

/**
 * Tag each candidate a reranker kept with `rerank-survivor`, preserving every
 * prior stage tag and the candidate order. Idempotent — tagging an already-tagged
 * set adds nothing. Every provider funnels its output through this so survivor
 * provenance is identical regardless of which reranker produced the order.
 */
export function tagRerankSurvivors(
  candidates: readonly HybridCandidate[],
): readonly HybridCandidate[] {
  return candidates.map(withSurvivorTag)
}

/**
 * The deterministic, provider-free reranker: authority-weighted, then fused
 * score (ADR 0002's hierarchy is the primary key — a governing source sorts
 * before a lower one at equal-ish relevance). Reuses #15's `rerankByAuthority`
 * ordering verbatim and tags the survivors. This is the `authority` A/B arm and
 * the default the off-provider names.
 */
export const authorityRerank: AgentRerank = async ({ candidates }) =>
  tagRerankSurvivors(rerankByAuthority(candidates))

/**
 * A SCRIPTED FAKE reranker for tests: returns the candidates in the given path-key
 * order, then appends any candidate the script omitted (in its original order) so
 * a partial ranking never drops a retrieved cite. Survivors are tagged exactly as
 * a live provider's would be — the test seam is provenance-faithful.
 */
export function scriptedRerank(orderByPathKey: readonly string[]): AgentRerank {
  return async ({ candidates }) => {
    const byKey = new Map(candidates.map((c) => [c.citablePathKey, c]))
    const ranked: HybridCandidate[] = []
    const taken = new Set<string>()
    for (const key of orderByPathKey) {
      const hit = byKey.get(key)
      if (hit && !taken.has(key)) {
        ranked.push(hit)
        taken.add(key)
      }
    }
    for (const candidate of candidates) {
      if (!taken.has(candidate.citablePathKey)) ranked.push(candidate)
    }
    return tagRerankSurvivors(ranked)
  }
}

export { type AgentRerank }
