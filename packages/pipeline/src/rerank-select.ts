/**
 * The rerank A/B provider switch (#16) — a pure function mapping the
 * `rerankProvider` flag to a concrete {@link AgentRerank} seam.
 *
 * The deterministic `authority` reranker is owned here (it needs no binding); the
 * `llm` and `cohere` rerankers are LIVE seams injected by the caller (built under
 * `live/`, never constructed in this module), so the switch stays unit-testable
 * against fakes — no live Cohere/Vertex call. A provider whose binding is absent
 * (e.g. the harness runs with no Cohere key) degrades to the deterministic
 * authority reranker rather than throwing: a missing key pins the deterministic
 * arm, it never breaks a run. Whether ANY reranker runs is the `rerank` flag's
 * job (off → raw RRF order); this only picks WHICH one when rerank is on.
 */

import { type AgentRerank } from './agent-types.js'
import { type RerankProvider } from './agent-query-flags.js'
import { authorityRerank } from './rerank.js'

/** The injected live rerank seams, keyed by provider (each optional). */
export interface InjectedRerankers {
  readonly llm?: AgentRerank
  readonly cohere?: AgentRerank
}

/**
 * Pick the reranker for a provider choice: the deterministic authority reranker
 * for `authority`, otherwise the injected live seam — falling back to authority
 * when that binding is absent. Pure: never constructs a live client.
 */
export function selectReranker(provider: RerankProvider, injected: InjectedRerankers): AgentRerank {
  switch (provider) {
    case 'authority':
      return authorityRerank
    case 'llm':
      return injected.llm ?? authorityRerank
    case 'cohere':
      return injected.cohere ?? authorityRerank
  }
}
