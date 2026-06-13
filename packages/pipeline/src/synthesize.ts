/**
 * Plain synthesis under the shared output contract (issue #10): take the
 * question and the retrieved candidates, ask the runtime LLM (Gemini on Vertex)
 * to answer strictly from them, and parse the result into a schema-valid
 * {@link AnswerEnvelope}.
 *
 * "Naive" means no agent graph, no Critic gate — but the envelope's cite
 * discipline is structural, not behavioral: a cite the model offers that is not
 * in the retrieved candidate set is dropped before grading, so the naive arm
 * cannot inflate its precision by inventing pin-cites it never retrieved. The
 * LLM call is injected as {@link LlmComplete} (a string→string completion), so
 * synthesis logic — prompt assembly, fenced-block stripping, JSON parsing,
 * candidate-set clamping, envelope validation — is unit-tested offline; the live
 * `ChatVertexAI` binding lives in the service/CLI.
 */

import { citablePathsEqual, type CitablePath } from '@owners-manual/core'

import { parseAnswerEnvelope, type AnswerEnvelope } from './answer-envelope.js'
import { type RetrievedCandidate } from './retrieve.js'

/** A model completion: prompt in, raw text out. Injected for testability. */
export type LlmComplete = (prompt: string) => Promise<string>

export interface SynthesizeOptions {
  readonly question: string
  readonly candidates: readonly RetrievedCandidate[]
  readonly complete: LlmComplete
}

export interface SynthesizeResult {
  readonly envelope: AnswerEnvelope
  /** The raw model text, kept for trace capture. */
  readonly rawModelOutput: string
}

const ENVELOPE_INSTRUCTION = `You answer Ontario condo-owner and tenancy questions using ONLY the numbered sources below.

Respond with a single JSON object, no prose outside it, in exactly this shape:
{
  "behaviorClass": one of "answer" | "refuse-jurisdiction" | "refuse-out-of-scope" | "refuse-advice-escalate" | "flag-void-clause",
  "answer": the human-facing answer text,
  "claims": [ { "text": one assertion, "cites": [ { "documentId": ..., "segments": [ { "kind": "part"|"section"|"subsection"|"clause", "label": ... } ] } ] } ]
}

Rules:
- Cite ONLY sources from the list below, by their exact documentId and segments. Do NOT invent or guess a citation that is not in the list.
- If the question is outside Ontario, off the condo/tenancy domain, or asks for legal advice/strategy, choose the matching refusal class and return an empty "claims" list.
- If a lease or contract clause conflicts with a statute in the sources, use "flag-void-clause".
- Never fabricate facts beyond the sources.`

/** Render one candidate as a numbered, addressable source block. */
function renderCandidate(candidate: RetrievedCandidate, index: number): string {
  const address = JSON.stringify({
    documentId: candidate.path.documentId,
    segments: candidate.path.segments,
  })
  return `[${index + 1}] address=${address}\n${candidate.text}`
}

/** Assemble the synthesis prompt: instruction, sources, then the question. */
export function buildSynthesisPrompt(
  question: string,
  candidates: readonly RetrievedCandidate[],
): string {
  const sources =
    candidates.length > 0 ? candidates.map(renderCandidate).join('\n\n') : '(no sources retrieved)'
  return `${ENVELOPE_INSTRUCTION}\n\nSOURCES:\n${sources}\n\nQUESTION:\n${question}`
}

/** Strip a leading/trailing ```json … ``` fence the model may wrap JSON in. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  return fence?.[1]?.trim() ?? trimmed
}

/** True when `cite` is one of the retrieved candidate addresses. */
function isRetrieved(cite: CitablePath, candidates: readonly RetrievedCandidate[]): boolean {
  return candidates.some((candidate) => citablePathsEqual(candidate.path, cite))
}

/** Drop any cite the model offered that was not actually retrieved. */
function clampToCandidates(
  envelope: AnswerEnvelope,
  candidates: readonly RetrievedCandidate[],
): AnswerEnvelope {
  return {
    ...envelope,
    claims: envelope.claims.map((claim) => ({
      ...claim,
      cites: claim.cites.filter((cite) => isRetrieved(cite, candidates)),
    })),
  }
}

/** Run synthesis and return a validated, candidate-clamped answer envelope. */
export async function synthesize(options: SynthesizeOptions): Promise<SynthesizeResult> {
  const { question, candidates, complete } = options
  const prompt = buildSynthesisPrompt(question, candidates)
  const rawModelOutput = await complete(prompt)

  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(rawModelOutput))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`synthesis did not return valid JSON: ${reason}`)
  }

  const envelope = clampToCandidates(parseAnswerEnvelope(parsed), candidates)
  return { envelope, rawModelOutput }
}
