import { describe, expect, it } from 'vitest'

import {
  AUTHORITY_LEVELS,
  authorityLevelOf,
  authorityRank,
  isHigherAuthority,
  type AuthorityLevel,
} from './authority.js'

/**
 * Authority level (#14): the metadata a candidate carries so hybrid retrieval
 * can pre-filter by authority (ADR 0002: metadata pre-filtering on corpus AND
 * authority level in a single query path) and a later rerank can weight by it.
 *
 * CONTEXT.md, "Authority hierarchy": Act > Regulation > Tribunal Guideline >
 * policy wording / contract clause; within governing documents Declaration >
 * Bylaws > Rules. This module maps a document id to its level deterministically
 * (the same ids the parser/corpus-loader use) and orders the levels so the
 * reranker and the debug endpoint speak one vocabulary.
 */

describe('AUTHORITY_LEVELS', () => {
  it('is ordered strongest-first and closed', () => {
    expect(AUTHORITY_LEVELS[0]).toBe('act')
    expect(AUTHORITY_LEVELS).toContain('regulation')
    expect(AUTHORITY_LEVELS).toContain('guideline')
    expect(AUTHORITY_LEVELS).toContain('declaration')
    expect(AUTHORITY_LEVELS).toContain('bylaw')
    expect(AUTHORITY_LEVELS).toContain('rule')
    expect(AUTHORITY_LEVELS).toContain('contract')
  })
})

describe('authorityLevelOf', () => {
  it('classifies the RTA and the Condominium Act as act-level', () => {
    expect(authorityLevelOf('rta-2006')).toBe('act')
    expect(authorityLevelOf('condo-act-1998')).toBe('act')
  })

  it('classifies the e-laws regulations as regulation-level', () => {
    expect(authorityLevelOf('reg-516-06')).toBe('regulation')
    expect(authorityLevelOf('reg-48-01')).toBe('regulation')
  })

  it('classifies LTB interpretation guidelines as guideline-level', () => {
    expect(authorityLevelOf('ltb-guideline-05')).toBe('guideline')
    expect(authorityLevelOf('ltb-guideline-12')).toBe('guideline')
  })

  it('classifies the designed declaration fixture as declaration-level', () => {
    expect(authorityLevelOf('fixture-declaration')).toBe('declaration')
  })

  it('classifies the designed rules fixture as rule-level', () => {
    expect(authorityLevelOf('fixture-rules')).toBe('rule')
  })

  it('classifies leases and insurance policies as contract-level', () => {
    expect(authorityLevelOf('fixture-lease')).toBe('contract')
    expect(authorityLevelOf('fixture-master-policy')).toBe('contract')
    expect(authorityLevelOf('fixture-unit-policy')).toBe('contract')
  })

  it('throws for an unknown document id rather than guessing', () => {
    expect(() => authorityLevelOf('totally-unknown')).toThrow(/unknown/i)
  })
})

describe('authorityRank / isHigherAuthority', () => {
  it('ranks act above regulation above guideline above contract', () => {
    expect(authorityRank('act')).toBeLessThan(authorityRank('regulation'))
    expect(authorityRank('regulation')).toBeLessThan(authorityRank('guideline'))
    expect(authorityRank('guideline')).toBeLessThan(authorityRank('contract'))
  })

  it('ranks declaration above bylaw above rule (governing-document chain)', () => {
    expect(authorityRank('declaration')).toBeLessThan(authorityRank('bylaw'))
    expect(authorityRank('bylaw')).toBeLessThan(authorityRank('rule'))
  })

  it('isHigherAuthority is true when the first level outranks the second', () => {
    expect(isHigherAuthority('act', 'contract')).toBe(true)
    expect(isHigherAuthority('contract', 'act')).toBe(false)
    expect(isHigherAuthority('act', 'act')).toBe(false)
  })

  it('every declared level has a distinct rank', () => {
    const ranks = AUTHORITY_LEVELS.map((level: AuthorityLevel) => authorityRank(level))
    expect(new Set(ranks).size).toBe(AUTHORITY_LEVELS.length)
  })
})
