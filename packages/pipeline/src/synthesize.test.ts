import { describe, expect, it } from 'vitest'

import { type RetrievedCandidate } from './retrieve.js'
import { buildSynthesisPrompt, synthesize, type LlmComplete } from './synthesize.js'

const candidates: RetrievedCandidate[] = [
  {
    documentId: 'rta-2006',
    citablePathKey: 'rta-2006|part:III|section:20|subsection:1',
    path: {
      documentId: 'rta-2006',
      segments: [
        { kind: 'part', label: 'III' },
        { kind: 'section', label: '20' },
        { kind: 'subsection', label: '1' },
      ],
    },
    text: 'The landlord is responsible for maintaining the rental unit.',
    score: 0.9,
    stage: 'vector',
  },
]

/** An LLM that returns a valid envelope JSON for the answer case. */
const okLlm: LlmComplete = async () =>
  JSON.stringify({
    behaviorClass: 'answer',
    answer: 'The landlord must maintain the unit.',
    claims: [
      {
        text: 'The landlord must maintain the unit.',
        cites: [
          {
            documentId: 'rta-2006',
            segments: [
              { kind: 'part', label: 'III' },
              { kind: 'section', label: '20' },
              { kind: 'subsection', label: '1' },
            ],
          },
        ],
      },
    ],
  })

describe('buildSynthesisPrompt', () => {
  it('includes the question and every candidate text with its address', () => {
    const prompt = buildSynthesisPrompt('who repairs the unit?', candidates)
    expect(prompt).toContain('who repairs the unit?')
    expect(prompt).toContain('The landlord is responsible for maintaining the rental unit.')
    expect(prompt).toContain('rta-2006')
  })

  it('instructs the model to emit the envelope and to refuse rather than guess', () => {
    const prompt = buildSynthesisPrompt('q', candidates)
    expect(prompt.toLowerCase()).toContain('behaviorclass')
    expect(prompt.toLowerCase()).toMatch(/refuse|only.*provided|do not (invent|guess)/)
  })
})

describe('synthesize', () => {
  it('returns a schema-valid answer envelope from the model output', async () => {
    const result = await synthesize({ question: 'q', candidates, complete: okLlm })
    expect(result.envelope.behaviorClass).toBe('answer')
    expect(result.envelope.claims[0]?.cites[0]?.documentId).toBe('rta-2006')
  })

  it('strips a fenced ```json code block before parsing', async () => {
    const fenced: LlmComplete = async () =>
      '```json\n' +
      JSON.stringify({ behaviorClass: 'refuse-out-of-scope', answer: 'No.', claims: [] }) +
      '\n```'
    const result = await synthesize({ question: 'q', candidates, complete: fenced })
    expect(result.envelope.behaviorClass).toBe('refuse-out-of-scope')
  })

  it('drops a claim cite that is not in the retrieved candidate set (no fabrication)', async () => {
    const fabricates: LlmComplete = async () =>
      JSON.stringify({
        behaviorClass: 'answer',
        answer: 'x',
        claims: [
          {
            text: 'x',
            cites: [
              { documentId: 'rta-2006', segments: [{ kind: 'section', label: '999' }] },
              {
                documentId: 'rta-2006',
                segments: [
                  { kind: 'part', label: 'III' },
                  { kind: 'section', label: '20' },
                  { kind: 'subsection', label: '1' },
                ],
              },
            ],
          },
        ],
      })
    const result = await synthesize({ question: 'q', candidates, complete: fabricates })
    const cites = result.envelope.claims.flatMap((c) => c.cites)
    expect(cites).toHaveLength(1)
    expect(cites[0]?.segments.at(-1)?.label).toBe('1')
  })

  it('throws a clear error when the model output is not valid JSON', async () => {
    const garbage: LlmComplete = async () => 'I am not JSON'
    await expect(synthesize({ question: 'q', candidates, complete: garbage })).rejects.toThrow(
      /JSON|parse/i,
    )
  })

  it('reports the raw model text for trace capture', async () => {
    const result = await synthesize({ question: 'q', candidates, complete: okLlm })
    expect(result.rawModelOutput).toContain('behaviorClass')
  })
})
