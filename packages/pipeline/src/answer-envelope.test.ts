import { describe, expect, it } from 'vitest'

import {
  ANSWER_BEHAVIOR_CLASSES,
  answerEnvelopeSchema,
  parseAnswerEnvelope,
  type AnswerEnvelope,
} from './answer-envelope.js'

/** A minimal valid `answer`-class envelope with one cited claim. */
function validAnswerEnvelope(): AnswerEnvelope {
  return {
    behaviorClass: 'answer',
    answer: 'The landlord must keep the rental unit in a good state of repair.',
    claims: [
      {
        text: 'The landlord must keep the rental unit in a good state of repair.',
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
  }
}

describe('answerEnvelopeSchema', () => {
  it('exposes the five behavior classes the golden set uses', () => {
    expect(ANSWER_BEHAVIOR_CLASSES).toEqual([
      'answer',
      'refuse-jurisdiction',
      'refuse-out-of-scope',
      'refuse-advice-escalate',
      'flag-void-clause',
    ])
  })

  it('validates a well-formed answer envelope', () => {
    const parsed = parseAnswerEnvelope(validAnswerEnvelope())
    expect(parsed.behaviorClass).toBe('answer')
    expect(parsed.claims).toHaveLength(1)
    expect(parsed.claims[0]?.cites[0]?.documentId).toBe('rta-2006')
  })

  it('allows a refusal envelope with no claims and no cites', () => {
    const refusal: AnswerEnvelope = {
      behaviorClass: 'refuse-jurisdiction',
      answer: 'I can only answer questions about Ontario tenancy law.',
      claims: [],
    }
    expect(() => parseAnswerEnvelope(refusal)).not.toThrow()
  })

  it('rejects an unknown behavior class', () => {
    const bad = { ...validAnswerEnvelope(), behaviorClass: 'made-up' }
    expect(() => parseAnswerEnvelope(bad)).toThrow()
  })

  it('rejects an envelope missing the answer prose', () => {
    const bad = { behaviorClass: 'answer', claims: [] }
    expect(() => parseAnswerEnvelope(bad)).toThrow()
  })

  it('rejects a claim whose cite is structurally invalid', () => {
    const bad = {
      behaviorClass: 'answer',
      answer: 'x',
      claims: [{ text: 'x', cites: [{ documentId: 'rta-2006', segments: [{ kind: 'bogus' }] }] }],
    }
    expect(() => parseAnswerEnvelope(bad)).toThrow()
  })

  it('rejects unknown top-level keys (strict envelope)', () => {
    const bad = { ...validAnswerEnvelope(), surprise: true }
    expect(() => answerEnvelopeSchema.parse(bad)).toThrow()
  })

  it('extracts every candidate cite across all claims via citePaths', () => {
    const envelope = parseAnswerEnvelope({
      behaviorClass: 'answer',
      answer: 'x',
      claims: [
        {
          text: 'a',
          cites: [{ documentId: 'rta-2006', segments: [{ kind: 'section', label: '20' }] }],
        },
        {
          text: 'b',
          cites: [{ documentId: 'rta-2006', segments: [{ kind: 'section', label: '14' }] }],
        },
      ],
    })
    expect(envelope.claims.flatMap((c) => c.cites)).toHaveLength(2)
  })
})
