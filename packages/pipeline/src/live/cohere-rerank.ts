/**
 * The live Cohere Rerank binding (#16): an {@link AgentRerank} backed by Cohere
 * Rerank 3.5 over the stdlib `fetch` (no new dependency — mirrors the harness's
 * urllib approach). One arm of the rerank A/B; the other is `llm-rerank`, and the
 * deterministic baseline is `authorityRerank`.
 *
 * The API key is read by the caller (`resolveCohereApiKey`) and passed in — it
 * never passes through tests, and this module is LIVE BY DESIGN and not unit-
 * tested (the rerank node's flag gating, the survivor tagging, and the provider
 * selector are all covered upstream against fakes; this only adapts that to one
 * HTTP call). Cohere returns a ranking over the candidate TEXTS; we map the
 * returned indices back to the original {@link HybridCandidate} rows, keep the
 * authority hierarchy as a deterministic tiebreak the model cannot see, tag the
 * survivors `rerank-survivor`, and append any candidate Cohere omitted so no
 * retrieved cite is ever dropped (the same safety the scripted fake enforces).
 */

import { type AgentRerank } from '../agent-types.js'
import { authorityRank } from '../authority.js'
import { type HybridCandidate } from '../hybrid-retrieve.js'
import { tagRerankSurvivors } from '../rerank.js'

export interface CohereRerankOptions {
  /** The Cohere API key (resolved by the caller; never hardcoded or logged). */
  readonly apiKey: string
  /** The Cohere rerank model; defaults to the current Rerank 3.5 multilingual. */
  readonly model?: string
  /** Override the API base (tests/proxies); defaults to the public endpoint. */
  readonly baseUrl?: string
}

const DEFAULT_MODEL = 'rerank-v3.5'
const DEFAULT_BASE_URL = 'https://api.cohere.com'

/** One result row Cohere returns: the original index and its relevance score. */
interface CohereResult {
  readonly index: number
  readonly relevance_score: number
}

/**
 * Build an {@link AgentRerank} over the live Cohere Rerank API. Reorders the
 * candidates by Cohere's relevance, breaking ties by the authority hierarchy
 * (ADR 0002) so a governing source still wins a dead heat. Empty candidate sets
 * short-circuit (no HTTP call).
 */
export function createCohereRerank(options: CohereRerankOptions): AgentRerank {
  const model = options.model ?? DEFAULT_MODEL
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL

  return async ({ question, candidates }) => {
    if (candidates.length === 0) return candidates

    const response = await fetch(`${baseUrl}/v2/rerank`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        query: question,
        documents: candidates.map((c) => c.text),
      }),
    })
    if (!response.ok) {
      throw new Error(`Cohere rerank failed: ${response.status} ${response.statusText}`)
    }
    const body = (await response.json()) as { readonly results?: readonly CohereResult[] }
    const results = body.results ?? []

    // Map Cohere's ranked indices back to candidate rows; break score ties by
    // authority (the model never sees authority, so it is a deterministic tiebreak).
    const ordered = [...results]
      .sort((a, b) => {
        if (b.relevance_score !== a.relevance_score) return b.relevance_score - a.relevance_score
        const ca = candidates[a.index]
        const cb = candidates[b.index]
        if (!ca || !cb) return 0
        return authorityRank(ca.authorityLevel) - authorityRank(cb.authorityLevel)
      })
      .map((r) => candidates[r.index])
      .filter((c): c is HybridCandidate => c !== undefined)

    // Append any candidate Cohere did not score, in original order — never drop one.
    const taken = new Set(ordered.map((c) => c.citablePathKey))
    const tail = candidates.filter((c) => !taken.has(c.citablePathKey))
    return tagRerankSurvivors([...ordered, ...tail])
  }
}
