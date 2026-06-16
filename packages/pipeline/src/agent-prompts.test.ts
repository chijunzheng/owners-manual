import { describe, expect, it } from 'vitest'

import {
  buildAgentSynthesisPrompt,
  buildCriticPrompt,
  buildGuardPrompt,
  buildPlannerPrompt,
  buildReformulatePrompt,
  buildSessionSummaryPrompt,
} from './agent-prompts.js'
import { REPAIR_CANDIDATE } from './agent-fixtures.js'
import { SESSION_SUMMARY_MAX_CHARS } from './session-memory.js'

describe('buildGuardPrompt', () => {
  it('names all four guard verdicts and the question', () => {
    const prompt = buildGuardPrompt('can my landlord raise rent 10%?')
    expect(prompt).toContain('refuse-jurisdiction')
    expect(prompt).toContain('refuse-out-of-scope')
    expect(prompt).toContain('refuse-advice-escalate')
    expect(prompt).toContain('injectionDetected')
    expect(prompt).toContain('can my landlord raise rent 10%?')
  })
})

describe('buildPlannerPrompt', () => {
  it('states the hop cap and asks for a structured plan', () => {
    const prompt = buildPlannerPrompt('tenant flood — who pays?', 3)
    expect(prompt).toContain('At most 3 hops')
    expect(prompt).toContain('"hops"')
    expect(prompt).toContain('"multiHop"')
  })
})

describe('buildAgentSynthesisPrompt', () => {
  it('embeds the numbered, addressable source and the envelope shape', () => {
    const prompt = buildAgentSynthesisPrompt('who repairs the unit?', [REPAIR_CANDIDATE])
    expect(prompt).toContain('[1] address=')
    expect(prompt).toContain('"behaviorClass"')
    expect(prompt).toContain('flag-void-clause')
    expect(prompt).toContain('rta-2006')
  })

  it('marks no sources when the candidate set is empty', () => {
    const prompt = buildAgentSynthesisPrompt('q', [])
    expect(prompt).toContain('(no sources retrieved)')
  })

  it('omits the definitions block when no definitions are attached (the off fallback)', () => {
    const prompt = buildAgentSynthesisPrompt('q', [REPAIR_CANDIDATE], [])
    expect(prompt).not.toContain('DEFINED TERMS')
  })

  it('renders attached definitions (#16 definitionsInPrompt) with their defining path', () => {
    const prompt = buildAgentSynthesisPrompt(
      'q',
      [REPAIR_CANDIDATE],
      [{ term: 'good state of repair', definedAtPathKey: 'rta-2006|part:I|section:2|clause:def' }],
    )
    expect(prompt).toContain('DEFINED TERMS')
    expect(prompt).toContain('good state of repair')
    expect(prompt).toContain('rta-2006|part:I|section:2|clause:def')
  })

  it('surfaces the owner profile block when one is supplied (#17 cross-session facts)', () => {
    const prompt = buildAgentSynthesisPrompt('q', [REPAIR_CANDIDATE], [], {
      ownerProfile: { ownerId: 'o', facts: { unit: 'Unit 1203', building: 'YCC-42' } },
    })
    expect(prompt).toContain('OWNER PROFILE')
    expect(prompt).toContain('Unit 1203')
    expect(prompt).toContain('YCC-42')
  })

  it('surfaces the session memory block when one is supplied (#17 bounded summary)', () => {
    const prompt = buildAgentSynthesisPrompt('q', [REPAIR_CANDIDATE], [], {
      sessionMemory: {
        sessionId: 's',
        summary: 'Earlier the owner asked about the master policy deductible.',
        turnCount: 2,
      },
    })
    expect(prompt).toContain('CONVERSATION SO FAR')
    expect(prompt).toContain('master policy deductible')
  })

  it('omits both memory blocks when neither is supplied (the #15/#16 baseline prompt)', () => {
    const prompt = buildAgentSynthesisPrompt('q', [REPAIR_CANDIDATE], [])
    expect(prompt).not.toContain('OWNER PROFILE')
    expect(prompt).not.toContain('CONVERSATION SO FAR')
  })

  it('renders profile and session as SEPARATE labelled blocks (distinct mechanisms)', () => {
    const prompt = buildAgentSynthesisPrompt('q', [REPAIR_CANDIDATE], [], {
      ownerProfile: { ownerId: 'o', facts: { unit: 'Unit 7' } },
      sessionMemory: { sessionId: 's', summary: 'asked about repairs', turnCount: 1 },
    })
    expect(prompt.indexOf('OWNER PROFILE')).toBeGreaterThanOrEqual(0)
    expect(prompt.indexOf('CONVERSATION SO FAR')).toBeGreaterThanOrEqual(0)
    // Two distinct blocks, not merged into one.
    expect(prompt.indexOf('OWNER PROFILE')).not.toBe(prompt.indexOf('CONVERSATION SO FAR'))
  })
})

describe('buildCriticPrompt', () => {
  it('asks for a grounding verdict and forbids rewriting', () => {
    const prompt = buildCriticPrompt('q', 'the landlord pays', [REPAIR_CANDIDATE])
    expect(prompt).toContain('"grounded"')
    expect(prompt).toContain('"ungroundedClaims"')
    expect(prompt).toContain('Do NOT rewrite')
    expect(prompt).toContain('the landlord pays')
  })
})

describe('buildReformulatePrompt', () => {
  it('asks to broaden recall, keep scope, and embeds the question', () => {
    const prompt = buildReformulatePrompt('who fixes it?')
    expect(prompt).toContain('BROADEN')
    expect(prompt).toContain('Ontario condo-ownership scope')
    expect(prompt).toContain('who fixes it?')
  })

  it('asks for a single plain-text query (no JSON) so the rewrite is bare text', () => {
    const prompt = buildReformulatePrompt('q')
    expect(prompt).toMatch(/no JSON/i)
    expect(prompt).toMatch(/single line of plain text/i)
  })
})

describe('buildSessionSummaryPrompt (#17 bounded summarization)', () => {
  it('embeds the prior summary, the new turn, and asks to COMPRESS not transcribe', () => {
    const prompt = buildSessionSummaryPrompt({
      priorSummary: 'The owner asked about the master policy.',
      question: 'who repairs the unit?',
      answer: 'The landlord must keep the unit in repair.',
    })
    expect(prompt).toContain('The owner asked about the master policy.')
    expect(prompt).toContain('who repairs the unit?')
    expect(prompt).toContain('The landlord must keep the unit in repair.')
    // The instruction must drive a bounded SUMMARY, not a growing transcript.
    expect(prompt).toMatch(/summar|condens|compress/i)
  })

  it('states the character bound so the model targets a bounded summary', () => {
    const prompt = buildSessionSummaryPrompt({ priorSummary: '', question: 'q', answer: 'a' })
    expect(prompt).toContain(String(SESSION_SUMMARY_MAX_CHARS))
  })
})
