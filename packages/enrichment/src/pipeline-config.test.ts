import { describe, expect, it } from 'vitest'

import {
  canonicalJson,
  computeBuildMetadata,
  hashPipelineConfig,
  parsePipelineConfig,
  type PipelineConfig,
} from './pipeline-config.js'

/**
 * The build identity (ADR 0004: "Corpus builds are content-addressed —
 * hash(source manifest + pipeline config)"). These tests pin the two acceptance
 * criteria this slice carries: the build hash changes iff the manifest or the
 * pipeline config changes (sensitivity to every field, and stability when
 * nothing moves), and the pinned enrichment model is recorded in build metadata.
 * They also pin {@link canonicalJson}'s key-order-insensitivity — the property
 * that makes the hash depend on values, never on JSON key insertion order.
 */

const config = (overrides: Partial<PipelineConfig> = {}): PipelineConfig => ({
  chunkerId: 'citable-unit',
  enrichmentModel: 'claude-sonnet-4-5-20250929',
  promptVersions: {
    'situating-context': 'v1',
    'cross-references': 'v1',
  },
  ...overrides,
})

const manifestHash = 'a'.repeat(64)

/** A config with one required field dropped, for the rejection tests. */
const without = (field: keyof PipelineConfig): Partial<PipelineConfig> => {
  const rest: Record<string, unknown> = { ...config() }
  delete rest[field]
  return rest
}

describe('canonicalJson', () => {
  it('sorts object keys recursively so insertion order never matters', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } })
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
  })

  it('handles primitives and null', () => {
    expect(canonicalJson('x')).toBe('"x"')
    expect(canonicalJson(7)).toBe('7')
    expect(canonicalJson(null)).toBe('null')
  })
})

describe('hashPipelineConfig', () => {
  it('returns a lowercase 64-char hex digest', () => {
    expect(hashPipelineConfig(config())).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic across calls', () => {
    expect(hashPipelineConfig(config())).toBe(hashPipelineConfig(config()))
  })

  it('is independent of key insertion order in promptVersions', () => {
    const a = config({ promptVersions: { 'situating-context': 'v1', 'cross-references': 'v1' } })
    const b = config({ promptVersions: { 'cross-references': 'v1', 'situating-context': 'v1' } })
    expect(hashPipelineConfig(a)).toBe(hashPipelineConfig(b))
  })

  it('changes when the chunker id changes', () => {
    expect(hashPipelineConfig(config())).not.toBe(
      hashPipelineConfig(config({ chunkerId: 'hierarchy-v1' })),
    )
  })

  it('changes when the enrichment model changes', () => {
    expect(hashPipelineConfig(config())).not.toBe(
      hashPipelineConfig(config({ enrichmentModel: 'claude-opus-4-1' })),
    )
  })

  it('changes when any prompt version is bumped', () => {
    const bumped = config({
      promptVersions: { 'situating-context': 'v2', 'cross-references': 'v1' },
    })
    expect(hashPipelineConfig(config())).not.toBe(hashPipelineConfig(bumped))
  })
})

describe('computeBuildMetadata', () => {
  it('produces a lowercase 64-char build hash', () => {
    const meta = computeBuildMetadata({ manifestHash, pipelineConfig: config() })
    expect(meta.buildHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic for unchanged inputs (the "if" half of "iff")', () => {
    const a = computeBuildMetadata({ manifestHash, pipelineConfig: config() })
    const b = computeBuildMetadata({ manifestHash, pipelineConfig: config() })
    expect(a.buildHash).toBe(b.buildHash)
  })

  it('changes the build hash when the manifest hash changes', () => {
    const a = computeBuildMetadata({ manifestHash, pipelineConfig: config() })
    const b = computeBuildMetadata({ manifestHash: 'b'.repeat(64), pipelineConfig: config() })
    expect(a.buildHash).not.toBe(b.buildHash)
  })

  it('changes the build hash when the chunker id changes', () => {
    const a = computeBuildMetadata({ manifestHash, pipelineConfig: config() })
    const b = computeBuildMetadata({
      manifestHash,
      pipelineConfig: config({ chunkerId: 'hierarchy-v1' }),
    })
    expect(a.buildHash).not.toBe(b.buildHash)
  })

  it('changes the build hash when the enrichment model changes', () => {
    const a = computeBuildMetadata({ manifestHash, pipelineConfig: config() })
    const b = computeBuildMetadata({
      manifestHash,
      pipelineConfig: config({ enrichmentModel: 'claude-opus-4-1' }),
    })
    expect(a.buildHash).not.toBe(b.buildHash)
  })

  it('changes the build hash when a prompt version is bumped', () => {
    const a = computeBuildMetadata({ manifestHash, pipelineConfig: config() })
    const b = computeBuildMetadata({
      manifestHash,
      pipelineConfig: config({
        promptVersions: { 'situating-context': 'v2', 'cross-references': 'v1' },
      }),
    })
    expect(a.buildHash).not.toBe(b.buildHash)
  })

  it('is insensitive to promptVersions key insertion order', () => {
    const a = computeBuildMetadata({
      manifestHash,
      pipelineConfig: config({
        promptVersions: { 'situating-context': 'v1', 'cross-references': 'v1' },
      }),
    })
    const b = computeBuildMetadata({
      manifestHash,
      pipelineConfig: config({
        promptVersions: { 'cross-references': 'v1', 'situating-context': 'v1' },
      }),
    })
    expect(a.buildHash).toBe(b.buildHash)
  })

  it('records the pinned enrichment model at the top level of build metadata', () => {
    const meta = computeBuildMetadata({ manifestHash, pipelineConfig: config() })
    expect(meta.enrichmentModel).toBe('claude-sonnet-4-5-20250929')
  })

  it('carries the manifest hash and full pipeline config through unchanged', () => {
    const pipelineConfig = config()
    const meta = computeBuildMetadata({ manifestHash, pipelineConfig })
    expect(meta.manifestHash).toBe(manifestHash)
    expect(meta.pipelineConfig).toEqual(pipelineConfig)
  })
})

describe('parsePipelineConfig', () => {
  it('accepts a well-formed config and returns it typed', () => {
    expect(parsePipelineConfig(config())).toEqual(config())
  })

  it('rejects an unknown top-level key instead of silently stripping it', () => {
    // Zod's default object behavior strips unknown keys, which would let a
    // misspelled or not-yet-supported build knob vanish BEFORE hashing — the
    // supplied config bytes change but the build identity does not. The config
    // IS the build identity, so unsupported config must fail loudly.
    expect(() => parsePipelineConfig({ ...config(), embedingModel: 'typo-knob' })).toThrow()
  })

  it('rejects a missing chunkerId', () => {
    expect(() => parsePipelineConfig(without('chunkerId'))).toThrow()
  })

  it('rejects an empty chunkerId', () => {
    expect(() => parsePipelineConfig(config({ chunkerId: '' }))).toThrow()
  })

  it('rejects a missing enrichmentModel', () => {
    expect(() => parsePipelineConfig(without('enrichmentModel'))).toThrow()
  })

  it('rejects an empty enrichmentModel', () => {
    expect(() => parsePipelineConfig(config({ enrichmentModel: '' }))).toThrow()
  })

  it('rejects missing promptVersions', () => {
    expect(() => parsePipelineConfig(without('promptVersions'))).toThrow()
  })

  it('rejects an empty prompt version value', () => {
    expect(() =>
      parsePipelineConfig(config({ promptVersions: { 'situating-context': '' } })),
    ).toThrow()
  })

  it('rejects a non-object input', () => {
    expect(() => parsePipelineConfig('nope')).toThrow()
    expect(() => parsePipelineConfig(null)).toThrow()
  })
})
