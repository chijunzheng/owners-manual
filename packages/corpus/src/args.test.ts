import { describe, expect, it } from 'vitest'

import { DEFAULT_MANIFEST, DEFAULT_RAW_ROOT, parseArgs } from './cli.js'

describe('parseArgs', () => {
  it('defaults to the committed manifest path and raw root in fetch mode', () => {
    const options = parseArgs([])
    expect(options.manifestPath).toBe(DEFAULT_MANIFEST)
    expect(options.rawRoot).toBe(DEFAULT_RAW_ROOT)
    expect(options.verifyOnly).toBe(false)
  })

  it('parses --verify-only', () => {
    expect(parseArgs(['--verify-only']).verifyOnly).toBe(true)
  })

  it('parses --manifest and --raw with values', () => {
    const options = parseArgs(['--manifest', '/tmp/m.json', '--raw', '/tmp/raw'])
    expect(options.manifestPath).toBe('/tmp/m.json')
    expect(options.rawRoot).toBe('/tmp/raw')
  })

  it('throws when --manifest is missing its value', () => {
    expect(() => parseArgs(['--manifest'])).toThrow(/--manifest/)
  })

  it('throws when --raw is missing its value', () => {
    expect(() => parseArgs(['--raw'])).toThrow(/--raw/)
  })

  it('throws on an unknown flag', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/unknown/i)
  })

  it('defaults --only to an empty list (meaning all sources)', () => {
    expect(parseArgs([]).only).toEqual([])
  })

  it('parses a single --only id', () => {
    expect(parseArgs(['--only', 'rta-2006']).only).toEqual(['rta-2006'])
  })

  it('accumulates repeated --only flags in order', () => {
    const options = parseArgs(['--only', 'rta-2006', '--only', 'reg-516-06'])
    expect(options.only).toEqual(['rta-2006', 'reg-516-06'])
  })

  it('composes --only with --verify-only', () => {
    const options = parseArgs(['--verify-only', '--only', 'rta-2006'])
    expect(options.verifyOnly).toBe(true)
    expect(options.only).toEqual(['rta-2006'])
  })

  it('throws when --only is missing its value', () => {
    expect(() => parseArgs(['--only'])).toThrow(/--only/)
  })

  it('does not mutate the input argv', () => {
    const argv = ['--only', 'rta-2006', '--verify-only']
    const snapshot = [...argv]
    parseArgs(argv)
    expect(argv).toEqual(snapshot)
  })
})
