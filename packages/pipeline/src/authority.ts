/**
 * Authority level (#14) — the metadata that lets hybrid retrieval pre-filter by
 * authority and a later rerank weight by it.
 *
 * CONTEXT.md, "Authority hierarchy", is the source of truth: Act > Regulation >
 * Tribunal Guideline > policy wording / contract clause, and within governing
 * documents Declaration > Bylaws > Rules. This module turns a document id (the
 * same ids the corpus-loader and parser use) into a level, and orders the levels
 * so the reranker, the metadata filter, and the debug endpoint share one
 * vocabulary. Classification is by id, not by reparsing the document, because
 * the id already determines the source's nature (it mirrors the manifest /
 * fixture registry). An unknown id throws rather than defaulting to a level — a
 * silently mis-ranked source is a correctness bug, not a shrug.
 */

/** The authority levels, ordered strongest-first (index 0 outranks the rest). */
export const AUTHORITY_LEVELS = [
  'act',
  'regulation',
  'guideline',
  'declaration',
  'bylaw',
  'rule',
  'contract',
] as const

export type AuthorityLevel = (typeof AUTHORITY_LEVELS)[number]

/** Explicit id → level mappings for the documents the corpus ingests. */
const EXPLICIT_LEVELS: Readonly<Record<string, AuthorityLevel>> = {
  'rta-2006': 'act',
  'condo-act-1998': 'act',
  'reg-516-06': 'regulation',
  'reg-48-01': 'regulation',
  'fixture-declaration': 'declaration',
  'fixture-rules': 'rule',
  // Resident "policies" published by management carry no governing-document
  // authority of their own; they sit at the rule tier of the chain.
  'fixture-management-policies': 'rule',
  'fixture-lease': 'contract',
  'fixture-master-policy': 'contract',
  'fixture-unit-policy': 'contract',
}

/** Rank of each level: lower number == higher authority. */
const RANK: ReadonlyMap<AuthorityLevel, number> = new Map(
  AUTHORITY_LEVELS.map((level, index) => [level, index]),
)

/**
 * The authority level of a document id. LTB interpretation guidelines are
 * matched by their `ltb-guideline-*` family prefix (there are several); every
 * other source is mapped explicitly. Throws for an unknown id.
 */
export function authorityLevelOf(documentId: string): AuthorityLevel {
  const explicit = EXPLICIT_LEVELS[documentId]
  if (explicit) return explicit
  if (documentId.startsWith('ltb-guideline-')) return 'guideline'
  throw new Error(`unknown document id "${documentId}" — cannot assign an authority level`)
}

/**
 * The inverse of {@link authorityLevelOf} (#41): the document ids, drawn from the
 * corpus's KNOWN id set, whose authority level is one of `levels` — the allow-list
 * the pre-filter pushes into `$vectorSearch.filter` / the `$search` compound
 * (ADR 0002: metadata pre-filtering on corpus AND authority level in one query
 * path).
 *
 * The known-id set is supplied by the caller (the corpus manifest / fixture
 * registry at the serve call site), NOT enumerated here: `authorityLevelOf`
 * classifies one id but the open `ltb-guideline-*` family has no closed list to
 * invert. Each known id is classified by the same by-id rule, so a mis-wired id
 * throws rather than silently dropping out of the allow-list. The result is
 * deduplicated and keeps first-seen order over the known set, so the emitted
 * filter is deterministic.
 */
export function documentIdsForAuthorityLevels(
  levels: readonly AuthorityLevel[],
  knownDocumentIds: readonly string[],
): readonly string[] {
  const wanted = new Set<AuthorityLevel>(levels)
  const allow: string[] = []
  const seen = new Set<string>()
  for (const id of knownDocumentIds) {
    if (seen.has(id)) continue
    seen.add(id)
    if (wanted.has(authorityLevelOf(id))) allow.push(id)
  }
  return allow
}

/**
 * The optional pre-filter resolver the live call sites share (#41): the documentId
 * allow-list for an OPTIONAL set of requested authority levels over an OPTIONAL
 * known-id set. Returns undefined — no pre-filter, fall back to the post-fusion
 * guard — when either input is absent (no levels requested, or no corpus id set to
 * invert against), so the pre-filter is never built from a hardcoded id list.
 */
export function resolveDocumentFilter(
  authorityLevels: readonly AuthorityLevel[] | undefined,
  corpusDocumentIds: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!authorityLevels || !corpusDocumentIds) return undefined
  return documentIdsForAuthorityLevels(authorityLevels, corpusDocumentIds)
}

/** The rank of an authority level: lower is higher authority (act === 0). */
export function authorityRank(level: AuthorityLevel): number {
  const rank = RANK.get(level)
  if (rank === undefined) throw new Error(`unknown authority level "${level}"`)
  return rank
}

/** True when `a` is a strictly higher authority than `b`. */
export function isHigherAuthority(a: AuthorityLevel, b: AuthorityLevel): boolean {
  return authorityRank(a) < authorityRank(b)
}
