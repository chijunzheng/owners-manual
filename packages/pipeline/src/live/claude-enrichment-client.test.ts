import { describe, expect, it } from 'vitest'

import { parseClaudeCliResult } from './claude-enrichment-client.js'

/**
 * The PURE `claude -p --output-format json` envelope parser (#16). The subprocess
 * runner around it is live-by-design and untested, but this read crosses the same
 * trust boundary the judge's `parse_judge_cli_envelope` does (ADR 0008): an
 * enrichment pass that proceeded on a failed CLI call would feed garbage into the
 * validating tree-enrichment parser, so a malformed/error/missing envelope must
 * throw loud rather than return a bad completion.
 */

describe('parseClaudeCliResult', () => {
  it('returns the model result text from a well-formed envelope', () => {
    const stdout = JSON.stringify({
      is_error: false,
      result: '{"edges":[]}',
      total_cost_usd: 0.01,
    })
    expect(parseClaudeCliResult(stdout)).toBe('{"edges":[]}')
  })

  it('throws descriptively when the envelope is not valid JSON', () => {
    expect(() => parseClaudeCliResult('{ not json')).toThrow(/claude CLI.*JSON/i)
  })

  it('throws when the envelope is valid JSON but not an object', () => {
    expect(() => parseClaudeCliResult('42')).toThrow(/claude CLI envelope is not a JSON object/i)
  })

  it('throws when the envelope reports an error (is_error)', () => {
    const stdout = JSON.stringify({ is_error: true, result: 'rate limited' })
    expect(() => parseClaudeCliResult(stdout)).toThrow(/claude CLI reported an error/i)
  })

  it('throws when the envelope has no string result field', () => {
    const stdout = JSON.stringify({ is_error: false, result: { edges: [] } })
    expect(() => parseClaudeCliResult(stdout)).toThrow(/no string 'result' field/i)
  })

  it('throws when the result field is absent entirely', () => {
    const stdout = JSON.stringify({ is_error: false, total_cost_usd: 0.01 })
    expect(() => parseClaudeCliResult(stdout)).toThrow(/no string 'result' field/i)
  })
})
