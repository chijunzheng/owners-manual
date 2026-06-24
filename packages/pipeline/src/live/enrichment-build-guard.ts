/**
 * The fail-loud corpus-identity guard for the live enrichment binding (#16).
 *
 * The agent's query-time graph expansion resolves a cross-reference edge's far
 * endpoint to a candidate through the chunk store, while the cross-reference
 * EDGES come from the persisted #13 sidecars. If those sidecars were built
 * against a different corpus than the one serve is retrieving over, expansion
 * would graft edges from one build onto chunks from another — a silent
 * correctness hole the eval would never flag as a bug, only as worse numbers.
 *
 * ADR 0004 makes both builds content-addressed by the SAME corpus hash, so the
 * check is an equality assertion: the artifact records the `corpusBuildHash` its
 * producer computed, serve passes the `corpusBuildHash` from its run record, and
 * a disagreement THROWS at serve start (CONTEXT.md / coding style: fail loud on a
 * misconfiguration, never a quiet fallback). Pure over its inputs so it is
 * unit-tested offline.
 */

/** The two corpus build hashes the guard reconciles. */
export interface EnrichmentBuildGuardInput {
  /** The `corpusBuildHash` the persisted enrichment artifact was built against. */
  readonly artifactCorpusBuildHash: string
  /** The `corpusBuildHash` serve derives from its run record (the corpus it serves). */
  readonly corpusBuildHash: string
}

/**
 * Assert the persisted enrichment build was produced against the corpus serve is
 * answering over. Throws a descriptive error naming both hashes when they
 * disagree — a stale or wrong-corpus artifact is a configuration error surfaced
 * here, by hash, rather than as a mis-grafted expansion target mid query.
 */
export function assertEnrichmentBuildMatchesCorpus(input: EnrichmentBuildGuardInput): void {
  if (input.artifactCorpusBuildHash !== input.corpusBuildHash) {
    throw new Error(
      'enrichment artifact corpus build hash does not match the serving corpus: ' +
        `artifact "${input.artifactCorpusBuildHash}" vs serve "${input.corpusBuildHash}". ` +
        'Re-run `enrich:build` against the current corpus before serving.',
    )
  }
}
