/**
 * The agent's QUERY-TIME ablation flags (#16) — the surface #23's two-ladder
 * ablation knocks each component out from.
 *
 * #16 adds three flagged components to the bounded Guard→Critic graph (#15) plus
 * the on/off and provider-choice for rerank; #23 needs each individually
 * ablatable. So every component lands behind a flag here, every flag's OFF-state
 * is a DEFINED, DOCUMENTED fallback (documented inline below, pinned by
 * `agent-query-flags.test.ts`), and all of them flip on the SAME corpus build —
 * these are query-time knobs, never an index rebuild (CONTEXT.md: "the matrix
 * leans on query-time dimensions because they're free"). This mirrors the
 * enrichment package's index-time `ConsumerFlags` seam (default-off, `.strict()`,
 * deeply frozen default), and in fact REUSES its `xrefExpansion` /
 * `definitionsInPrompt` flag names — the same query-time ablations, now consumed
 * by the agent graph rather than left as producer-side placeholders.
 *
 * The documented OFF-state fallbacks (the ablation contract):
 *   - `xrefExpansion` off  → no cross-reference graph expansion; the candidate
 *     set is exactly hybrid retrieval's output (the #15 path).
 *   - `definitionsInPrompt` off → no definitions-index entries attached to
 *     synthesis; the synthesizer sees only the retrieved candidates.
 *   - `queryReformulation` off → no reformulation; a single retrieve pass per
 *     plan (the #15 path — reformulation never fires).
 *   - `rerank` off → raw RRF/similarity order (the retrieve node's
 *     `mergeCandidates` fused-score order); NO authority weighting is applied.
 *   - `rerankProvider` → which reranker runs WHEN `rerank` is on; ignored when
 *     `rerank` is off. Defaults to `authority` (deterministic, provider-free) so
 *     a flag set is never ambiguous even with rerank off.
 */

import { z } from 'zod'

/**
 * The selectable rerank providers (#16: "Cohere Rerank vs LLM-rerank behind a
 * flag"). `authority` is the deterministic, provider-free reranker (#15's
 * authority-weighted order); `llm` and `cohere` are the live A/B options bound
 * behind the {@link import('./agent-types.js').AgentRerank} seam. A closed set so
 * an unknown provider fails loudly at the config boundary.
 */
export const RERANK_PROVIDERS = ['authority', 'llm', 'cohere'] as const

export type RerankProvider = (typeof RERANK_PROVIDERS)[number]

/**
 * The agent's query-time flag set — all booleans plus the rerank-provider choice.
 * Readonly so a flag set is a value, not a mutable bag (matches `ConsumerFlags`).
 */
export interface AgentQueryFlags {
  /** Expand the candidate set one hop over the cross-reference graph sidecar. */
  readonly xrefExpansion: boolean
  /** Attach definitions-index entries to the synthesis prompt. */
  readonly definitionsInPrompt: boolean
  /** Enable the bounded query-reformulation edge at the retrieve node (≤ 1 hop). */
  readonly queryReformulation: boolean
  /** Apply reranking; off-state is the raw RRF/similarity (fused-score) order. */
  readonly rerank: boolean
  /** Which reranker to run when {@link rerank} is on; ignored when off. */
  readonly rerankProvider: RerankProvider
}

/**
 * The all-off baseline (every component disabled). This IS the #15 query path:
 * no expansion, no definitions, no reformulation, no authority weighting — the
 * fallback every ablation measures lift against. Deeply frozen so it can't drift.
 */
export const AGENT_QUERY_FLAGS_OFF: AgentQueryFlags = Object.freeze({
  xrefExpansion: false,
  definitionsInPrompt: false,
  queryReformulation: false,
  rerank: false,
  rerankProvider: 'authority',
})

/**
 * Validates an untyped flag set: each flag defaults to its off-state when
 * omitted, and unknown keys are REJECTED (`.strict()`) so a typo like
 * `xref_expansion` fails loudly instead of silently leaving its flag off
 * (matches `consumerFlagsSchema`).
 */
export const agentQueryFlagsSchema = z
  .object({
    xrefExpansion: z.boolean().default(false),
    definitionsInPrompt: z.boolean().default(false),
    queryReformulation: z.boolean().default(false),
    rerank: z.boolean().default(false),
    rerankProvider: z.enum(RERANK_PROVIDERS).default('authority'),
  })
  .strict()

/**
 * Parse and normalize an untyped flag set into {@link AgentQueryFlags}: missing
 * fields become their off-state, unknown keys throw. Throws {@link z.ZodError}
 * on invalid input so a misconfigured ablation is caught at the boundary.
 */
export function parseAgentQueryFlags(value: unknown): AgentQueryFlags {
  return agentQueryFlagsSchema.parse(value)
}

/** True for the env truthy spellings a flag is "on" under ("1" or "true"). */
function envOn(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

/**
 * Resolve the agent query flags from process env (`OWNERS_MANUAL_*`). These are
 * QUERY-TIME knobs: flipping one changes the next request's behaviour on the SAME
 * corpus build — no re-index (CONTEXT.md: "query-time dimensions because they're
 * free"). A flag is off unless explicitly `1`/`true`; the rerank provider is
 * validated through the schema so an unknown provider fails loud at startup.
 */
export function resolveAgentQueryFlags(env: NodeJS.ProcessEnv = process.env): AgentQueryFlags {
  return parseAgentQueryFlags({
    xrefExpansion: envOn(env.OWNERS_MANUAL_XREF_EXPANSION),
    definitionsInPrompt: envOn(env.OWNERS_MANUAL_DEFINITIONS_IN_PROMPT),
    queryReformulation: envOn(env.OWNERS_MANUAL_QUERY_REFORMULATION),
    rerank: envOn(env.OWNERS_MANUAL_RERANK),
    rerankProvider: env.OWNERS_MANUAL_RERANK_PROVIDER?.trim() || 'authority',
  })
}
