import { describe, expect, it } from 'vitest'

import { type CorpusChunk } from './chunk-corpus.js'
import {
  buildStuffedCandidates,
  permuteCanonicalOrder,
  stuffedSourceCount,
  synthesizeStuffed,
  type StuffLlmComplete,
} from './stuff-synthesis.js'

const chunks: CorpusChunk[] = [
  {
    id: 'rta-2006#0',
    citablePathKey: 'rta-2006|part:III|section:20|subsection:1',
    text: 'The landlord must keep the unit in a good state of repair.',
    documentId: 'rta-2006',
    chunker: 'hierarchy-v1',
  },
  {
    id: 'fixture-lease#0',
    citablePathKey: 'fixture-lease|section:pets|clause:p-1',
    text: 'No pets of any kind are permitted.',
    documentId: 'fixture-lease',
    chunker: 'hierarchy-v1',
  },
]

const okEnvelope = JSON.stringify({
  behaviorClass: 'answer',
  answer: 'The landlord must keep the unit in repair.',
  claims: [
    {
      text: 'The landlord must keep the unit in repair.',
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

/** A scripted fake stuff-LLM: returns fixed text plus a fixed usage record. */
function fakeStuffLlm(
  text: string,
  usage: { promptTokens: number; cachedPromptTokens: number; completionTokens: number },
): StuffLlmComplete {
  return async () => ({ text, usage })
}

describe('buildStuffedCandidates', () => {
  it('turns every corpus chunk into a candidate tagged stuffed, in chunk order', () => {
    const candidates = buildStuffedCandidates(chunks)
    expect(candidates.map((c) => c.citablePathKey)).toEqual([
      'rta-2006|part:III|section:20|subsection:1',
      'fixture-lease|section:pets|clause:p-1',
    ])
    expect(candidates.every((c) => c.stage === 'stuffed')).toBe(true)
    expect(candidates[0]?.path.documentId).toBe('rta-2006')
  })
})

describe('permuteCanonicalOrder', () => {
  it('returns the same multiset of chunks in a deterministic, different order for a seed', () => {
    const permuted = permuteCanonicalOrder(chunks, 1)
    expect(permuted.map((c) => c.id).sort()).toEqual(chunks.map((c) => c.id).sort())
  })

  it('is deterministic: the same seed yields the same order', () => {
    const a = permuteCanonicalOrder(chunks, 7).map((c) => c.id)
    const b = permuteCanonicalOrder(chunks, 7).map((c) => c.id)
    expect(a).toEqual(b)
  })

  it('leaves canonical order unchanged at seed 0 (the baseline)', () => {
    expect(permuteCanonicalOrder(chunks, 0).map((c) => c.id)).toEqual(chunks.map((c) => c.id))
  })
})

describe('stuffedSourceCount', () => {
  it('reports how many sources were stuffed (honest no-RAG: the whole set)', () => {
    expect(stuffedSourceCount(chunks)).toBe(2)
  })
})

describe('synthesizeStuffed', () => {
  it('returns a schema-valid envelope and the recorded usage', async () => {
    const result = await synthesizeStuffed({
      question: 'who repairs the unit?',
      candidates: buildStuffedCandidates(chunks),
      complete: fakeStuffLlm(okEnvelope, {
        promptTokens: 1000,
        cachedPromptTokens: 900,
        completionTokens: 50,
      }),
    })
    expect(result.envelope.behaviorClass).toBe('answer')
    expect(result.usage.promptTokens).toBe(1000)
    expect(result.usage.cachedPromptTokens).toBe(900)
  })

  it('drops a cite the model invents that is not in the stuffed set (no fabrication)', async () => {
    const fabricates = fakeStuffLlm(
      JSON.stringify({
        behaviorClass: 'answer',
        answer: 'x',
        claims: [
          {
            text: 'x',
            cites: [{ documentId: 'rta-2006', segments: [{ kind: 'section', label: '999' }] }],
          },
        ],
      }),
      { promptTokens: 10, cachedPromptTokens: 0, completionTokens: 1 },
    )
    const result = await synthesizeStuffed({
      question: 'q',
      candidates: buildStuffedCandidates(chunks),
      complete: fabricates,
    })
    expect(result.envelope.claims.flatMap((c) => c.cites)).toHaveLength(0)
  })

  it('throws a clear error when the model output is not valid JSON', async () => {
    await expect(
      synthesizeStuffed({
        question: 'q',
        candidates: buildStuffedCandidates(chunks),
        complete: fakeStuffLlm('not json', {
          promptTokens: 1,
          cachedPromptTokens: 0,
          completionTokens: 1,
        }),
      }),
    ).rejects.toThrow(/JSON/i)
  })

  it('builds a prompt that stuffs every source text (the model sees the whole corpus)', async () => {
    let seenPrompt = ''
    const capturing: StuffLlmComplete = async (prompt) => {
      seenPrompt = prompt
      return {
        text: okEnvelope,
        usage: { promptTokens: 1, cachedPromptTokens: 0, completionTokens: 1 },
      }
    }
    await synthesizeStuffed({
      question: 'who repairs the unit?',
      candidates: buildStuffedCandidates(chunks),
      complete: capturing,
    })
    expect(seenPrompt).toContain('The landlord must keep the unit in a good state of repair.')
    expect(seenPrompt).toContain('No pets of any kind are permitted.')
    expect(seenPrompt).toContain('who repairs the unit?')
  })
})
