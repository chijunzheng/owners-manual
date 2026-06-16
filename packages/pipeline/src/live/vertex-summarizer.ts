/**
 * The live session-memory summarizer (#17): a {@link SessionSummarizer} backed
 * by the stock `ChatVertexAI` (ADR 0005 — Gemini on Vertex, keyless ADC), the
 * same runtime model the agent uses. It folds each turn into the rolling summary
 * via the pure {@link buildSessionSummaryPrompt}; the caller's `appendTurn`
 * hard-caps the reply, so this binding only needs to ask for a bounded summary,
 * not enforce the bound.
 *
 * The model string is the pinned flagship from pipeline config — never hardcoded
 * here — matching `createVertexLlm`. Live by design and not unit-tested: the
 * bound, the prompt, and the load-summarize-save loop are covered upstream
 * against deterministic fakes (`session-memory` / `agent-prompts` / `chat-service`).
 */

import { ChatVertexAI } from '@langchain/google-vertexai'

import { buildSessionSummaryPrompt } from '../agent-prompts.js'
import { type SessionSummarizer } from '../session-memory.js'

export interface VertexSummarizerOptions {
  readonly model: string
  readonly location: string
}

/** Build a {@link SessionSummarizer} over a pinned Vertex Gemini model. */
export function createVertexSummarizer(options: VertexSummarizerOptions): SessionSummarizer {
  const chat = new ChatVertexAI({ model: options.model, location: options.location, maxRetries: 2 })
  return async ({ priorSummary, question, answer }) => {
    const prompt = buildSessionSummaryPrompt({ priorSummary, question, answer })
    const reply = await chat.invoke(prompt)
    const text = typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
    return text.trim()
  }
}
