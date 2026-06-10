import { describe, expect, it } from 'vitest'

import { renderReport } from './report.js'
import type { VerifyReport } from './verify.js'
import type { ManifestSource } from './manifest/schema.js'

function source(id: string): ManifestSource {
  return {
    id,
    title: `Title ${id}`,
    url: `https://example.test/${id}`,
    file: `${id}.txt`,
    sha256: 'a'.repeat(64),
    bytes: 10,
    consolidationDate: '2024-01-01',
    licence: { holder: "King's Printer for Ontario", note: 'n' },
    normalization: 'none',
  }
}

describe('renderReport', () => {
  it('summarizes an all-ok run as verified', () => {
    const report: VerifyReport = {
      ok: true,
      okCount: 2,
      failedCount: 0,
      results: [
        { status: 'ok', source: source('rta-2006'), actual: { sha256: 'a'.repeat(64), bytes: 10 } },
        { status: 'ok', source: source('reg-516'), actual: { sha256: 'b'.repeat(64), bytes: 20 } },
      ],
    }
    const text = renderReport(report)
    expect(text).toMatch(/2 ok/)
    expect(text).toMatch(/0 failed/)
    expect(text).toMatch(/rta-2006/)
  })

  it('names the mismatched source and shows expected vs actual digests', () => {
    const report: VerifyReport = {
      ok: false,
      okCount: 0,
      failedCount: 1,
      results: [
        {
          status: 'mismatch',
          source: source('reg-516'),
          expected: { sha256: 'a'.repeat(64), bytes: 10 },
          actual: { sha256: 'c'.repeat(64), bytes: 11 },
        },
      ],
    }
    const text = renderReport(report)
    expect(text).toMatch(/reg-516/)
    expect(text).toMatch(/mismatch/i)
    expect(text).toContain('a'.repeat(64)) // expected
    expect(text).toContain('c'.repeat(64)) // actual
    expect(text).toMatch(/https:\/\/example\.test\/reg-516/)
  })

  it('surfaces a fetch error with its message', () => {
    const report: VerifyReport = {
      ok: false,
      okCount: 0,
      failedCount: 1,
      results: [{ status: 'error', source: source('guideline'), message: 'HTTP 503' }],
    }
    const text = renderReport(report)
    expect(text).toMatch(/guideline/)
    expect(text).toMatch(/error/i)
    expect(text).toMatch(/HTTP 503/)
  })

  it('ends with a clear FAIL line when not ok', () => {
    const report: VerifyReport = {
      ok: false,
      okCount: 1,
      failedCount: 1,
      results: [
        { status: 'ok', source: source('a'), actual: { sha256: 'a'.repeat(64), bytes: 1 } },
        { status: 'error', source: source('b'), message: 'boom' },
      ],
    }
    const text = renderReport(report)
    expect(text).toMatch(/FAIL/)
  })

  it('ends with a clear OK line when verified', () => {
    const report: VerifyReport = {
      ok: true,
      okCount: 1,
      failedCount: 0,
      results: [{ status: 'ok', source: source('a'), actual: { sha256: 'a'.repeat(64), bytes: 1 } }],
    }
    expect(renderReport(report)).toMatch(/OK\b/)
  })

  it('is deterministic for the same input', () => {
    const report: VerifyReport = {
      ok: true,
      okCount: 1,
      failedCount: 0,
      results: [{ status: 'ok', source: source('a'), actual: { sha256: 'a'.repeat(64), bytes: 1 } }],
    }
    expect(renderReport(report)).toBe(renderReport(report))
  })
})
