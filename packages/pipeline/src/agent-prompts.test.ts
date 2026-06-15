import { describe, expect, it } from 'vitest'

import {
  buildAgentSynthesisPrompt,
  buildCriticPrompt,
  buildGuardPrompt,
  buildPlannerPrompt,
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
