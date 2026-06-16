/**
 * The live LLM-rerank binding (#16): an {@link AgentRerank} backed by the runtime
 * Gemini model on Vertex (ADR 0005 — the same product model the agent runs, so
 * the rerank A/B measures the reranker, never a model swap). The other A/B arm is
 * Cohere Rerank; the deterministic baseline is `authorityRerank`.
 *
 * LIVE BY DESIGN and not unit-tested — the rerank node's flag gating, the
 * survivor tagging, and the provider selector are covered upstream against fakes;
 * this only adapts that to one Vertex call. The model is asked to return a JSON
 * array of candidate indices, best-first; we map them back to the original
 * {@link HybridCandidate} rows, break ties by the authority hierarchy (ADR 0002)
 * the model cannot see, tag survivors `rerank-survivor`, and append any candidate
 * the model omitted so no retrieved cite is ever dropped.
 */

import { ChatVertexAI } from '@langchain/google-vertexai'
import { z } from 'zod'

import { type AgentRerank } from '../agent-types.js'
import { type HybridCandidate } from '../hybrid-retrieve.js'
import { tagRerankSurvivors } from '../rerank.js'

export interface LlmRerankOptions {
  readonly model: string
  readonly location: string
}

const rankingSchema = z.object({ ranking: z.array(z.number().int().nonnegative()) }).strict()

/** Strip a ```json fence, then JSON.parse. */
function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  const body = fence?.[1]?.trim() ?? trimmed
  return JSON.parse(body)
}

/** Render the candidates as an indexed list the model ranks by relevance. */
function renderForRanking(candidates: readonly HybridCandidate[]): string {
  return candidates.map((c, i) => `[${i}] (${c.authorityLevel}) ${c.text}`).join('\n')
}

/**
 * Build an {@link AgentRerank} over the runtime Vertex Gemini model. Asks for a
 * best-first index ranking, maps it back to candidate rows, and falls back to the
 * input order for any index the model dropped. Empty sets short-circuit.
 */
export function createLlmRerank(options: LlmRerankOptions): AgentRerank {
  const chat = new ChatVertexAI({ model: options.model, location: options.location, maxRetries: 2 })

  return async ({ question, candidates }) => {
    if (candidates.length === 0) return candidates

    const prompt = [
      'Rank the numbered sources by how directly they answer the QUESTION.',
      'Respond with strict JSON {"ranking":[<index>,...]} listing source indices best-first.',
      'Include every index exactly once. Do not invent an index.',
      '',
      'SOURCES:',
      renderForRanking(candidates),
      '',
      'QUESTION:',
      question,
    ].join('\n')

    const reply = await chat.invoke(prompt)
    const raw = typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
    const { ranking } = rankingSchema.parse(parseJsonObject(raw))

    const ordered: HybridCandidate[] = []
    const taken = new Set<number>()
    for (const index of ranking) {
      const candidate = candidates[index]
      if (candidate && !taken.has(index)) {
        ordered.push(candidate)
        taken.add(index)
      }
    }
    // Append any candidate the model omitted, in original order — never drop one.
    candidates.forEach((candidate, index) => {
      if (!taken.has(index)) ordered.push(candidate)
    })
    return tagRerankSurvivors(ordered)
  }
}
