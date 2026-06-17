/**
 * The live retrieve binding for the agent graph (#15): closes #14's frozen
 * `retrieveHybrid` over the embedding provider + Atlas vector/BM25 executors and
 * exposes the narrow {@link AgentRetrieve} shape the graph's retrieve node calls.
 *
 * The agent CONSUMES hybrid retrieval, never reshapes it (issue #15 / #14 froze
 * the contract): this is a thin partial application, mapping the graph's
 * per-hop `{ question, topK, authorityLevels }` onto `retrieveHybrid`'s options
 * and returning its candidates verbatim. Live by design; the retrieve node's
 * merge/rerank logic is unit-tested upstream against a fake retrieve seam.
 */

import { resolveDocumentFilter } from '../authority.js'
import { type AgentRetrieve, type AgentRetrieveDeps } from '../agent-types.js'
import { retrieveHybrid } from '../hybrid-retrieve.js'

/** Build an {@link AgentRetrieve} from the live hybrid-retrieval dependencies. */
export function createAgentRetrieve(deps: AgentRetrieveDeps): AgentRetrieve {
  return async ({ question, topK, authorityLevels }) => {
    const result = await retrieveHybrid({
      question,
      topK,
      provider: deps.provider,
      vectorSearch: deps.vectorSearch,
      textSearch: deps.textSearch,
      authorityLevels,
      // Push the resolved allow-list into the stages as a true pre-filter (#41);
      // the post-fusion `authorityLevels` guard remains as belt-and-suspenders.
      documentFilter: resolveDocumentFilter(authorityLevels, deps.corpusDocumentIds),
    })
    return result.candidates
  }
}
