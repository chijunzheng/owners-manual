/**
 * The live runtime LLM binding: a {@link LlmComplete} backed by the stock
 * `ChatVertexAI` (ADR 0005 — Gemini on Vertex, keyless ADC). Project resolves
 * from GOOGLE_CLOUD_PROJECT via ADC; only the location is passed explicitly,
 * matching the verified providers-package access pattern.
 *
 * The model string is the pinned stable flagship from pipeline config — never
 * hardcoded here — so a swap is a config change. No `maxOutputTokens` /
 * `temperature` are set: at the `global` location the SDK's response handler
 * throws on truncated/empty content, and current Gemini exposes no temperature
 * control anyway (CONTEXT.md, "Variance audit") — synthesis is constrained by
 * the prompt instead.
 */

import { ChatVertexAI } from '@langchain/google-vertexai'

import { type LlmComplete } from '../synthesize.js'

export interface VertexLlmOptions {
  readonly model: string
  readonly location: string
}

/** Build a {@link LlmComplete} over a pinned Vertex Gemini model. */
export function createVertexLlm(options: VertexLlmOptions): LlmComplete {
  const chat = new ChatVertexAI({ model: options.model, location: options.location, maxRetries: 2 })
  return async (prompt: string) => {
    const reply = await chat.invoke(prompt)
    return typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
  }
}
