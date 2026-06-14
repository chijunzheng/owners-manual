/**
 * The live agent-model binding (#15): an {@link AgentModel} backed by the stock
 * `ChatVertexAI` (ADR 0005 — Gemini on Vertex, keyless ADC). One chat client
 * serves all four node seams (guard, plan, synthesize, critique) via the pure
 * prompt builders; synthesis STREAMS so the SSE endpoint relays tokens.
 *
 * The model string is the pinned flagship from pipeline config — never hardcoded
 * here — so a swap is a config change (matching `createVertexLlm`). Live by
 * design and not unit-tested: the prompts, the JSON parsing into the graph's
 * structured types, and the whole graph are covered upstream against the
 * scripted fake; this module only adapts that to one Vertex client.
 */

import { ChatVertexAI } from '@langchain/google-vertexai'
import { z } from 'zod'

import { AGENT_LOOP_CAPS, GUARD_VERDICTS } from '../agent-types.js'
import { AUTHORITY_LEVELS } from '../authority.js'
import {
  buildAgentSynthesisPrompt,
  buildCriticPrompt,
  buildGuardPrompt,
  buildPlannerPrompt,
} from '../agent-prompts.js'
import { type AgentModel } from '../agent-types.js'

export interface VertexAgentOptions {
  readonly model: string
  readonly location: string
}

/** Strip a ```json fence the model may wrap a JSON object in, then JSON.parse. */
function parseJsonObject(raw: string, label: string): unknown {
  const trimmed = raw.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  const body = fence?.[1]?.trim() ?? trimmed
  try {
    return JSON.parse(body)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`agent ${label} did not return valid JSON: ${reason}`)
  }
}

const guardSchema = z
  .object({
    verdict: z.enum(GUARD_VERDICTS),
    injectionDetected: z.boolean(),
    reason: z.string(),
  })
  .strict()

const planSchema = z
  .object({
    hops: z
      .array(
        z
          .object({
            query: z.string(),
            authorityLevels: z.array(z.enum(AUTHORITY_LEVELS)).optional(),
          })
          .strict(),
      )
      .min(1),
    multiHop: z.boolean(),
  })
  .strict()

const criticSchema = z
  .object({
    grounded: z.boolean(),
    ungroundedClaims: z.array(z.string()),
  })
  .strict()

/** Build an {@link AgentModel} over a pinned Vertex Gemini model. */
export function createVertexAgentModel(options: VertexAgentOptions): AgentModel {
  const chat = new ChatVertexAI({
    model: options.model,
    location: options.location,
    maxRetries: 2,
  })

  const complete = async (prompt: string): Promise<string> => {
    const reply = await chat.invoke(prompt)
    return typeof reply.content === 'string' ? reply.content : JSON.stringify(reply.content)
  }

  return {
    async guard({ question }) {
      const raw = await complete(buildGuardPrompt(question))
      return guardSchema.parse(parseJsonObject(raw, 'guard'))
    },

    async plan({ question }) {
      const raw = await complete(buildPlannerPrompt(question, AGENT_LOOP_CAPS.maxHops))
      return planSchema.parse(parseJsonObject(raw, 'planner'))
    },

    async synthesize({ question, candidates, onToken }) {
      const prompt = buildAgentSynthesisPrompt(question, candidates)
      // Stream so the SSE endpoint relays tokens as they arrive; accumulate the
      // full text to parse into the envelope (one artifact, two consumers).
      let text = ''
      const stream = await chat.stream(prompt)
      for await (const chunk of stream) {
        const piece = typeof chunk.content === 'string' ? chunk.content : ''
        if (piece) {
          text += piece
          onToken?.(piece)
        }
      }
      return text
    },

    async critique({ question, answer, candidates }) {
      const raw = await complete(buildCriticPrompt(question, answer, candidates))
      return criticSchema.parse(parseJsonObject(raw, 'critic'))
    },
  }
}
