/**
 * Stuffed synthesis for the no-retrieval arms (#18): instead of retrieving top-k
 * candidates, the whole stuffed corpus is placed in the model's context and it
 * answers strictly from it. The arms share the agent's output contract and the
 * SAME product model (ADR 0005) — arm gaps measure architecture, never model
 * choice — so this reuses synthesize.ts's prompt assembly, fenced-block
 * stripping, JSON parsing, candidate-set clamping, and envelope validation
 * verbatim; the ONLY differences from naive-rag synthesis are (1) the candidate
 * set is the corpus, not a retrieval result, and (2) the model call reports token
 * usage (including the Vertex context-cache hit) so cost-per-question is recorded
 * honestly. The live caching binding lives in the service/CLI; this module is
 * pure and unit-tested against a scripted fake.
 */

import { citablePathsEqual } from '@owners-manual/core'

import { parseAnswerEnvelope, type AnswerEnvelope } from './answer-envelope.js'
import { type CorpusChunk } from './chunk-corpus.js'
import { parsePathKey, type RetrievedCandidate } from './retrieve.js'
import { buildSynthesisPrompt } from './synthesize.js'

/**
 * The model's token usage for one stuffed call. `cachedPromptTokens` is the slice
 * of the prompt served from the Vertex context cache (the fixed corpus prefix);
 * recording it is what makes the stuffed arm's cost honest rather than billing
 * the full ~900K prompt on every question.
 */
export interface StuffUsage {
  readonly promptTokens: number
  readonly cachedPromptTokens: number
  readonly completionTokens: number
}

/** A stuffed model completion: prompt in, raw text + usage out. Injected for testability. */
export type StuffLlmComplete = (prompt: string) => Promise<{
  readonly text: string
  readonly usage: StuffUsage
}>

export interface SynthesizeStuffedOptions {
  readonly question: string
  /** The stuffed corpus as candidates, in the order they appear in context. */
  readonly candidates: readonly RetrievedCandidate[]
  readonly complete: StuffLlmComplete
}

export interface SynthesizeStuffedResult {
  readonly envelope: AnswerEnvelope
  readonly rawModelOutput: string
  readonly usage: StuffUsage
}

/**
 * Turn corpus chunks into the candidate set the stuffed prompt renders and the
 * grader clamps cites against. Every chunk becomes one candidate tagged
 * `stuffed` (a stuffed arm has no retrieval stage), preserving the input order —
 * the caller fixes that order (canonical for `stuff`, or a permutation for the
 * order probe).
 */
export function buildStuffedCandidates(
  chunks: readonly CorpusChunk[],
): readonly RetrievedCandidate[] {
  return chunks.map((chunk) => ({
    documentId: chunk.documentId,
    citablePathKey: chunk.citablePathKey,
    path: parsePathKey(chunk.citablePathKey),
    text: chunk.text,
    score: 0,
    stage: 'stuffed' as const,
  }))
}

/** How many sources were stuffed — the honest no-RAG denominator (the whole set). */
export function stuffedSourceCount(chunks: readonly CorpusChunk[]): number {
  return chunks.length
}

/**
 * A deterministic permutation of the chunk order for the order-permutation probe
 * (#18): confirms the `stuff` arm is not a prefix-order artifact. Seed `0` is the
 * identity (the canonical baseline); any other seed yields a stable shuffle of
 * the SAME chunks (a seeded Fisher–Yates), so a probe run is reproducible and the
 * reported result can name the seed it used.
 */
export function permuteCanonicalOrder(
  chunks: readonly CorpusChunk[],
  seed: number,
): readonly CorpusChunk[] {
  if (seed === 0) return chunks
  const out = [...chunks]
  // A small deterministic LCG seeded by `seed` — no global RNG, no dependency.
  let state = seed >>> 0 || 1
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1))
    const tmp = out[i]!
    out[i] = out[j]!
    out[j] = tmp
  }
  return out
}

/** Drop any cite the model offered that is not in the stuffed candidate set. */
function clampToStuffed(
  envelope: AnswerEnvelope,
  candidates: readonly RetrievedCandidate[],
): AnswerEnvelope {
  return {
    ...envelope,
    claims: envelope.claims.map((claim) => ({
      ...claim,
      cites: claim.cites.filter((cite) =>
        candidates.some((candidate) => citablePathsEqual(candidate.path, cite)),
      ),
    })),
  }
}

/** Strip a leading/trailing ```json … ``` fence the model may wrap JSON in. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  return fence?.[1]?.trim() ?? trimmed
}

/** Run stuffed synthesis: validated, stuffed-set-clamped envelope plus usage. */
export async function synthesizeStuffed(
  options: SynthesizeStuffedOptions,
): Promise<SynthesizeStuffedResult> {
  const { question, candidates, complete } = options
  const prompt = buildSynthesisPrompt(question, candidates)
  const { text: rawModelOutput, usage } = await complete(prompt)

  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(rawModelOutput))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`stuffed synthesis did not return valid JSON: ${reason}`)
  }

  const envelope = clampToStuffed(parseAnswerEnvelope(parsed), candidates)
  return { envelope, rawModelOutput, usage }
}
