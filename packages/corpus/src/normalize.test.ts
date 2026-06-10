import { describe, expect, it } from 'vitest'

import { normalizeBytes } from './normalize.js'

const enc = (s: string) => new TextEncoder().encode(s)

describe('normalizeBytes', () => {
  it('"none" returns the exact bytes unchanged', () => {
    const input = enc('line one\r\nline two\r\n')
    const out = normalizeBytes(input, 'none')
    expect(Buffer.from(out).equals(Buffer.from(input))).toBe(true)
  })

  it('"none" preserves a byte-identical reference (no copy semantics relied upon)', () => {
    const input = enc('abc')
    expect(Array.from(normalizeBytes(input, 'none'))).toEqual([97, 98, 99])
  })

  it('"crlf-to-lf" rewrites CRLF to LF', () => {
    const out = normalizeBytes(enc('a\r\nb\r\n'), 'crlf-to-lf')
    expect(new TextDecoder().decode(out)).toBe('a\nb\n')
  })

  it('"crlf-to-lf" rewrites a lone CR to LF', () => {
    const out = normalizeBytes(enc('a\rb'), 'crlf-to-lf')
    expect(new TextDecoder().decode(out)).toBe('a\nb')
  })

  it('"crlf-to-lf" leaves already-LF content unchanged', () => {
    const input = enc('a\nb\nc')
    const out = normalizeBytes(input, 'crlf-to-lf')
    expect(Buffer.from(out).equals(Buffer.from(input))).toBe(true)
  })

  it('"crlf-to-lf" is idempotent', () => {
    const once = normalizeBytes(enc('x\r\ny\rz\r\n'), 'crlf-to-lf')
    const twice = normalizeBytes(once, 'crlf-to-lf')
    expect(Buffer.from(twice).equals(Buffer.from(once))).toBe(true)
  })

  it('handles empty input', () => {
    expect(normalizeBytes(new Uint8Array(0), 'none').length).toBe(0)
    expect(normalizeBytes(new Uint8Array(0), 'crlf-to-lf').length).toBe(0)
    expect(normalizeBytes(new Uint8Array(0), 'strip-waf').length).toBe(0)
  })

  describe('strip-waf', () => {
    it('removes the volatile WAF bot-detection line (per-request __uzdbm tokens)', () => {
      const wafLine =
        '            <script>var __uzdbm_1 = "7e3831db";var __uzdbm_2 = "ODk0";</script> </head>'
      const doc = ['<head>', wafLine, '<title>RTA</title>'].join('\n')
      const out = new TextDecoder().decode(normalizeBytes(enc(doc), 'strip-waf'))
      expect(out).not.toContain('__uzdbm')
      expect(out).toContain('<title>RTA</title>')
      expect(out).toContain('<head>')
    })

    it('is byte-identical across two documents differing only in WAF tokens', () => {
      const docA = ['<head>', '<script>var __uzdbm_1 = "AAA";</script>', '<body>x</body>'].join('\n')
      const docB = ['<head>', '<script>var __uzdbm_1 = "ZZZ";</script>', '<body>x</body>'].join('\n')
      const a = normalizeBytes(enc(docA), 'strip-waf')
      const b = normalizeBytes(enc(docB), 'strip-waf')
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
    })

    it('leaves a document without a WAF line unchanged', () => {
      const doc = enc('<head>\n<title>clean</title>\n</head>')
      const out = normalizeBytes(doc, 'strip-waf')
      expect(Buffer.from(out).equals(Buffer.from(doc))).toBe(true)
    })

    it('is idempotent', () => {
      const doc = enc('<head>\n<script>var __uzdbm_1 = "x";</script>\n</head>')
      const once = normalizeBytes(doc, 'strip-waf')
      const twice = normalizeBytes(once, 'strip-waf')
      expect(Buffer.from(twice).equals(Buffer.from(once))).toBe(true)
    })

    it('removes every WAF line when more than one is present', () => {
      const doc = enc('a\n<script>var __uzdbm_1="1";</script>\nb\n<script>var __uzdbm_1="2";</script>\nc')
      const out = new TextDecoder().decode(normalizeBytes(doc, 'strip-waf'))
      expect(out).not.toContain('__uzdbm')
      expect(out.split('\n').filter((l) => l.length > 0)).toEqual(['a', 'b', 'c'])
    })
  })

  it('does not mutate its input buffer', () => {
    const input = enc('a\r\nb')
    const copy = Uint8Array.from(input)
    normalizeBytes(input, 'crlf-to-lf')
    expect(Buffer.from(input).equals(Buffer.from(copy))).toBe(true)
  })
})
