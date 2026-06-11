import { describe, expect, it } from 'vitest'

import type { Chunk } from './chunk.js'
import {
  DEFAULT_CONSUMER_FLAGS,
  consumerFlagsSchema,
  embeddableText,
  parseConsumerFlags,
  selectQueryTimeArtifacts,
  type ConsumerFlags,
} from './consumer-flags.js'

/**
 * Slice E of #13: the ablation flags live at the *consumer* of enrichment, not
 * the producer (ADR 0004 § Consequences). Enrichment artifacts are always
 * computed and cached; these flags decide whether a consumer USES them, so a
 * flag flip never re-runs a producer. Three flags exist, all default OFF.
 *
 * Amendment-note flagging is a correctness invariant, never ablatable — the
 * `ConsumerFlags`-has-exactly-three-keys test pins that it can never appear here.
 */

const chunk = (text: string): Chunk => ({
  id: 'citable-unit:RTA|section:1',
  citablePathKey: 'RTA|section:1',
  text,
})

describe('DEFAULT_CONSUMER_FLAGS', () => {
  it('has every flag off (the issue says default off)', () => {
    expect(DEFAULT_CONSUMER_FLAGS).toEqual({
      xrefExpansion: false,
      definitionsInPrompt: false,
      chunkContext: false,
    })
  })

  it('carries EXACTLY the three known flags — no amendment-flag ablation can sneak in', () => {
    expect(Object.keys(DEFAULT_CONSUMER_FLAGS).sort()).toEqual([
      'chunkContext',
      'definitionsInPrompt',
      'xrefExpansion',
    ])
  })

  it('is deeply frozen so the default can never be mutated in place', () => {
    expect(Object.isFrozen(DEFAULT_CONSUMER_FLAGS)).toBe(true)
  })
})

describe('parseConsumerFlags', () => {
  it('fills every missing field with false', () => {
    expect(parseConsumerFlags({})).toEqual({
      xrefExpansion: false,
      definitionsInPrompt: false,
      chunkContext: false,
    })
  })

  it('preserves the flags that are provided', () => {
    expect(parseConsumerFlags({ xrefExpansion: true })).toEqual({
      xrefExpansion: true,
      definitionsInPrompt: false,
      chunkContext: false,
    })
  })

  it('accepts a fully specified flag set', () => {
    const flags: ConsumerFlags = {
      xrefExpansion: true,
      definitionsInPrompt: true,
      chunkContext: true,
    }
    expect(parseConsumerFlags(flags)).toEqual(flags)
  })

  it('rejects unknown keys so a typo like xref_expansion is caught', () => {
    expect(() => parseConsumerFlags({ xref_expansion: true })).toThrow()
  })

  it('rejects a non-object input', () => {
    expect(() => parseConsumerFlags('nope')).toThrow()
    expect(() => parseConsumerFlags(null)).toThrow()
  })

  it('rejects a non-boolean flag value', () => {
    expect(() => parseConsumerFlags({ chunkContext: 'yes' })).toThrow()
  })

  it('exposes the underlying schema', () => {
    expect(consumerFlagsSchema.safeParse({}).success).toBe(true)
    expect(consumerFlagsSchema.safeParse({ bogus: 1 }).success).toBe(false)
  })
})

describe('embeddableText', () => {
  const flagsWith = (chunkContext: boolean): ConsumerFlags => ({
    xrefExpansion: false,
    definitionsInPrompt: false,
    chunkContext,
  })

  it('prepends the situating context when the flag is on and context is present', () => {
    expect(embeddableText(chunk('the body'), 'situating context', flagsWith(true))).toBe(
      'situating context\n\nthe body',
    )
  })

  it('returns the bare chunk text when the flag is off, even with context present', () => {
    expect(embeddableText(chunk('the body'), 'situating context', flagsWith(false))).toBe(
      'the body',
    )
  })

  it('returns the bare chunk text when the flag is on but no context is provided', () => {
    expect(embeddableText(chunk('the body'), undefined, flagsWith(true))).toBe('the body')
  })

  it('returns the bare chunk text when the flag is on but context is empty/whitespace', () => {
    expect(embeddableText(chunk('the body'), '', flagsWith(true))).toBe('the body')
    expect(embeddableText(chunk('the body'), '   \n  ', flagsWith(true))).toBe('the body')
  })

  it('never mutates the chunk it is given', () => {
    const input = chunk('the body')
    const frozen = Object.freeze({ ...input })
    embeddableText(frozen, 'situating context', flagsWith(true))
    expect(frozen.text).toBe('the body')
  })
})

describe('selectQueryTimeArtifacts', () => {
  const artifacts = { crossReferences: ['xref'], definitions: { Board: 'def' } }

  const select = (xrefExpansion: boolean, definitionsInPrompt: boolean) =>
    selectQueryTimeArtifacts(artifacts, {
      xrefExpansion,
      definitionsInPrompt,
      chunkContext: false,
    })

  it('passes neither artifact when both flags are off', () => {
    expect(select(false, false)).toEqual({
      crossReferences: undefined,
      definitions: undefined,
    })
  })

  it('passes only the cross-references when only xrefExpansion is on', () => {
    expect(select(true, false)).toEqual({
      crossReferences: artifacts.crossReferences,
      definitions: undefined,
    })
  })

  it('passes only the definitions when only definitionsInPrompt is on', () => {
    expect(select(false, true)).toEqual({
      crossReferences: undefined,
      definitions: artifacts.definitions,
    })
  })

  it('passes both artifacts when both flags are on', () => {
    expect(select(true, true)).toEqual({
      crossReferences: artifacts.crossReferences,
      definitions: artifacts.definitions,
    })
  })

  it('gates the two artifacts independently (xref on does not leak definitions)', () => {
    const result = select(true, false)
    expect(result.crossReferences).toBe(artifacts.crossReferences)
    expect(result.definitions).toBeUndefined()
  })
})
