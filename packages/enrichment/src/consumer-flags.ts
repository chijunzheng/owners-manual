/**
 * Ablation flags, attached where enrichment is CONSUMED — not produced (ADR 0004
 * § Consequences: "Ablation flags attach where enrichment is consumed, not
 * produced"). Slice E of #13 carries the acceptance criterion "Flags flip at
 * consumers without touching producers": enrichment artifacts are always
 * computed and cached, and these flags only decide whether a consumer USES them.
 * A flag flip therefore never re-runs a producer.
 *
 * Three flags exist, all default OFF (#13: "default off"):
 *   - `xrefExpansion` (retrieval, query-time): graph expansion over the
 *     cross-reference sidecar.
 *   - `definitionsInPrompt` (retrieval, query-time): attach definitions-index
 *     entries to the synthesize step.
 *   - `chunkContext` (indexing, index-time): prepend the chunk's situating
 *     context before embedding.
 *
 * Amendment-note flagging is a CORRECTNESS INVARIANT, never ablatable: it must
 * not appear in {@link ConsumerFlags}. The "exactly three keys" test pins that —
 * an amendment-flags ablation can never be added here silently.
 *
 * To stay decoupled from the sibling slices that produce these artifacts (the
 * cross-ref graph, the definitions index, the situating contexts), the consumer
 * seams here take STRUCTURAL parameter types defined locally or kept generic —
 * never imports of those slices' concrete types.
 */

import { z } from 'zod'

import type { Chunk } from './chunk.js'

/**
 * The set of ablatable consumer flags, all booleans. Exactly three — and never
 * an amendment-note flag, which is a correctness invariant rather than an
 * ablation. Readonly so a flag set is a value, not a mutable bag.
 */
export interface ConsumerFlags {
  /** Query-time: expand retrieval over the cross-reference graph sidecar. */
  readonly xrefExpansion: boolean
  /** Query-time: attach definitions-index entries to the synthesize prompt. */
  readonly definitionsInPrompt: boolean
  /** Index-time: prepend the chunk's situating context before embedding. */
  readonly chunkContext: boolean
}

/** The all-off default (#13: "default off"), deeply frozen so it can't drift. */
export const DEFAULT_CONSUMER_FLAGS: ConsumerFlags = Object.freeze({
  xrefExpansion: false,
  definitionsInPrompt: false,
  chunkContext: false,
})

/**
 * Validates an untyped flag set: each flag defaults to false when omitted, and
 * unknown keys are REJECTED (`.strict()`) so a typo like `xref_expansion` fails
 * loudly instead of silently leaving its intended flag off.
 */
export const consumerFlagsSchema = z
  .object({
    xrefExpansion: z.boolean().default(false),
    definitionsInPrompt: z.boolean().default(false),
    chunkContext: z.boolean().default(false),
  })
  .strict()

/**
 * Parse and normalize an untyped flag set into {@link ConsumerFlags}: missing
 * fields become false, unknown keys throw. Throws {@link z.ZodError} on invalid
 * input so a misconfigured ablation is caught at the boundary, not at use.
 */
export function parseConsumerFlags(value: unknown): ConsumerFlags {
  return consumerFlagsSchema.parse(value)
}

/**
 * The index-time consumer seam. Returns the text that should actually be
 * embedded for `chunk`: the situating context prepended to the chunk's text iff
 * {@link ConsumerFlags.chunkContext} is on AND a non-empty context is provided;
 * otherwise the chunk's text verbatim. Pure — never mutates `chunk`.
 */
export function embeddableText(
  chunk: Chunk,
  situatingContext: string | undefined,
  flags: ConsumerFlags,
): string {
  if (flags.chunkContext && situatingContext !== undefined && situatingContext.trim() !== '') {
    return `${situatingContext}\n\n${chunk.text}`
  }
  return chunk.text
}

/**
 * The query-time consumer seam. Passes each enrichment artifact through iff its
 * flag is on, replacing it with `undefined` otherwise — so a downstream step
 * sees an artifact only when its ablation flag enables it. Generic over the
 * artifact shapes so it never depends on the sibling slices' concrete types.
 */
export function selectQueryTimeArtifacts<G, D>(
  artifacts: { crossReferences: G; definitions: D },
  flags: ConsumerFlags,
): { crossReferences: G | undefined; definitions: D | undefined } {
  return {
    crossReferences: flags.xrefExpansion ? artifacts.crossReferences : undefined,
    definitions: flags.definitionsInPrompt ? artifacts.definitions : undefined,
  }
}
