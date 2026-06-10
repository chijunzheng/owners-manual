/**
 * The hierarchical cite matcher.
 *
 * Cite grading is hierarchical via citable paths (README, "Evaluation"): an
 * answer citing s. 49(1)(a) satisfies a required s. 49 — a descendant covers
 * its ancestor — while a bare s. 49 cited against a required subsection scores
 * partial. The same document tree that powers retrieval powers this metric,
 * deterministically. The matcher is the deepest shared primitive in the
 * project: the chunker, the critic gate, and the Python grader consume it, so
 * its verdicts are pinned by one cross-language conformance-vector set.
 *
 * A candidate is first *resolved* against the known document trees. A candidate
 * that addresses no real node is `unresolvable` (hallucination bait). A
 * resolvable candidate is then graded against the requirement:
 *   - identical path                              → `exact`
 *   - candidate strictly below the requirement    → `descendant-satisfies-ancestor`
 *   - candidate strictly above the requirement    → `ancestor-partial`
 *   - otherwise (sibling / cousin / cross-doc)    → `no-match`
 */

import {
  type CitablePath,
  citablePathsEqual,
  isProperAncestor,
  isProperDescendant,
} from './citable-path.js'
import { type DocumentTree, walkTree } from './document-tree.js'

/** The closed set of verdicts the matcher can return, ordered strongest-first. */
export const CITE_VERDICTS = [
  'exact',
  'descendant-satisfies-ancestor',
  'ancestor-partial',
  'no-match',
  'unresolvable',
] as const

export type CiteVerdict = (typeof CITE_VERDICTS)[number]

export interface MatchCiteInput {
  /** The pin-cite the golden item requires. */
  required: CitablePath
  /** The pin-cite the answer (or candidate set) actually offered. */
  candidate: CitablePath
  /** The known document trees the candidate is resolved against. */
  documents: DocumentTree[]
}

/** True when `path` addresses a real node in one of `documents`. */
export function resolvesToNode(path: CitablePath, documents: DocumentTree[]): boolean {
  const tree = documents.find((doc) => doc.documentId === path.documentId)
  if (!tree) return false
  let resolved = false
  walkTree(tree, (_node, nodePath) => {
    if (!resolved && citablePathsEqual(nodePath, path)) {
      resolved = true
    }
  })
  return resolved
}

/**
 * Grade `candidate` against `required`, resolving the candidate against the
 * supplied document trees. Returns exactly one {@link CiteVerdict}.
 */
export function matchCite({ required, candidate, documents }: MatchCiteInput): CiteVerdict {
  if (!resolvesToNode(candidate, documents)) {
    return 'unresolvable'
  }
  if (citablePathsEqual(candidate, required)) {
    return 'exact'
  }
  if (isProperDescendant(candidate, required)) {
    return 'descendant-satisfies-ancestor'
  }
  if (isProperAncestor(candidate, required)) {
    return 'ancestor-partial'
  }
  return 'no-match'
}

/** True when a candidate fully satisfies a required cite (exact or descendant). */
export function satisfiesRequirement(verdict: CiteVerdict): boolean {
  return verdict === 'exact' || verdict === 'descendant-satisfies-ancestor'
}
