import { describe, expect, it } from 'vitest'

import {
  buildAgentSynthesisPrompt,
  buildCriticPrompt,
  buildGuardPrompt,
  buildPlannerPrompt,
  buildReformulatePrompt,
} from './agent-prompts.js'
import { REPAIR_CANDIDATE } from './agent-fixtures.js'

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
