import { describe, expect, it } from 'vitest'

import {
  OWNER_PROFILE_FACT_KEYS,
  parseOwnerProfile,
  ownerProfileFactsSchema,
  renderOwnerProfileContext,
  type OwnerProfile,
} from './owner-profile.js'

/**
 * A wholly SYNTHETIC owner profile — an invented identity, never real personal
 * data (issue #17: "no real personal data in fixtures"). Reused across the
 * profile + cross-session tests.
 */
const SYNTHETIC_PROFILE: OwnerProfile = {
  ownerId: 'owner-synthetic-001',
  facts: {
    unit: 'Unit 1203',
    building: 'YCC-42 (12 Maple Crescent, Toronto)',
    policyNumber: 'POL-SYNTH-7788',
  },
}

describe('ownerProfileFactsSchema', () => {
  it('accepts the known fact keys (unit, building, policy identifiers)', () => {
    const facts = ownerProfileFactsSchema.parse(SYNTHETIC_PROFILE.facts)
    expect(facts.unit).toBe('Unit 1203')
    expect(facts.building).toContain('YCC-42')
    expect(facts.policyNumber).toBe('POL-SYNTH-7788')
  })

  it('treats every fact as optional — a sparse profile is valid', () => {
    const facts = ownerProfileFactsSchema.parse({ unit: 'Unit 5' })
    expect(facts.unit).toBe('Unit 5')
    expect(facts.building).toBeUndefined()
  })

  it('rejects an unknown fact key (strict — never smuggle unscored facts)', () => {
    expect(() => ownerProfileFactsSchema.parse({ ssn: '000-00-0000' })).toThrow()
  })

  it('exposes the canonical fact-key set', () => {
    expect([...OWNER_PROFILE_FACT_KEYS]).toEqual(['unit', 'building', 'policyNumber'])
  })
})

describe('parseOwnerProfile', () => {
  it('validates a full profile keyed by owner id', () => {
    const profile = parseOwnerProfile(SYNTHETIC_PROFILE)
    expect(profile.ownerId).toBe('owner-synthetic-001')
    expect(profile.facts.unit).toBe('Unit 1203')
  })

  it('rejects a profile with no owner id', () => {
    expect(() => parseOwnerProfile({ ownerId: '', facts: {} })).toThrow()
  })

  it('rejects an extra top-level field (strict)', () => {
    expect(() => parseOwnerProfile({ ownerId: 'o', facts: {}, sessionSummary: 'leaked' })).toThrow()
  })
})

describe('renderOwnerProfileContext', () => {
  it('renders the owner facts as a labelled, prompt-injectable block', () => {
    const block = renderOwnerProfileContext(SYNTHETIC_PROFILE)
    expect(block).toContain('Unit 1203')
    expect(block).toContain('YCC-42 (12 Maple Crescent, Toronto)')
    expect(block).toContain('POL-SYNTH-7788')
    // Labelled so the synthesis prompt can frame it as the owner's own situation.
    expect(block).toMatch(/owner/i)
  })

  it('renders nothing for an absent profile (the off-state fallback)', () => {
    expect(renderOwnerProfileContext(undefined)).toBe('')
  })

  it('renders nothing when a profile carries no facts (empty is not noise)', () => {
    expect(renderOwnerProfileContext({ ownerId: 'o', facts: {} })).toBe('')
  })

  it('omits unset facts rather than printing empty labels', () => {
    const block = renderOwnerProfileContext({ ownerId: 'o', facts: { unit: 'Unit 9' } })
    expect(block).toContain('Unit 9')
    // Only the set fact gets a bullet line; unset facts contribute no line.
    expect(block.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(1)
    expect(block).not.toContain('Insurance policy:')
    expect(block).not.toContain('Building:')
  })
})
