/**
 * Pure mapping from a LangChain `AIMessage.usage_metadata` to the stuffing arm's
 * {@link StuffUsage} (#18). Kept out of the live binding so the cache-hit read —
 * the one piece of the honest-cost path that has logic — is unit-tested without a
 * live Vertex call. `input_token_details.cache_read` is the slice of the prompt
 * the Vertex context cache served (the fixed corpus prefix); a call with no
 * caching reports no `cache_read`, which maps to zero cached tokens.
 */

import { type StuffUsage } from './stuff-synthesis.js'

/**
 * The slice of LangChain's `UsageMetadata` the stuffing arm reads. `total_tokens`
 * is declared (LangChain always sends it) but ignored — the honest cost splits
 * prompt vs cached vs completion, never the pre-summed total.
 */
export interface VertexUsageMetadata {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly total_tokens?: number
  readonly input_token_details?: { readonly cache_read?: number }
}

/** Map LangChain usage metadata into {@link StuffUsage}; absent fields are zero. */
export function mapVertexUsage(metadata: VertexUsageMetadata | undefined): StuffUsage {
  return {
    promptTokens: metadata?.input_tokens ?? 0,
    cachedPromptTokens: metadata?.input_token_details?.cache_read ?? 0,
    completionTokens: metadata?.output_tokens ?? 0,
  }
}
