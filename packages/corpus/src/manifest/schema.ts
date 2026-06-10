/**
 * Corpus-manifest schema and validator.
 *
 * The manifest is the committed record of every fetched source (URL, e-laws
 * consolidation/currency date, checksum, licence note) — raw corpus text is
 * never committed (Crown copyright), so the manifest plus the fetch script
 * reproduce it and pin which consolidation each eval number was measured
 * against. See CONTEXT.md → "Corpus manifest" and README → "Corpora".
 *
 * Validation is hand-rolled (no external schema dependency) because the shape
 * is small and self-contained, and adding a dep here would churn the root
 * lockfile against the parallel document-tree work.
 */

/**
 * Byte-normalization applied before hashing and before writing to disk.
 *
 * - `none` — identity; the bytes are hashed and stored verbatim.
 * - `strip-waf` — remove the volatile WAF/bot-detection script line that the
 *   ontario.ca and tribunalsontario.ca CDN injects with per-request random
 *   tokens. It is not part of the legal source; stripping it is what makes the
 *   statute/guideline HTML reproduce byte-identically (see README → "Corpora").
 * - `crlf-to-lf` — collapse line endings to LF (general utility).
 */
export type NormalizationPolicy = 'none' | 'strip-waf' | 'crlf-to-lf'

const NORMALIZATION_POLICIES: readonly NormalizationPolicy[] = ['none', 'strip-waf', 'crlf-to-lf']

/** Licence provenance for a single source (King's Printer, Tribunals Ontario, CAO). */
export interface LicenceNote {
  readonly holder: string
  readonly note: string
}

/** One fetched-and-checksummed source in the corpus manifest. */
export interface ManifestSource {
  /** Stable identifier referenced by builds and reports (e.g. "rta-2006"). */
  readonly id: string
  /** Human-readable citation of the source. */
  readonly title: string
  /** Canonical fetch URL. */
  readonly url: string
  /** Path under corpus/raw/ where the bytes are written. */
  readonly file: string
  /** Lowercase hex SHA-256 of the (normalized) bytes. */
  readonly sha256: string
  /** Byte length of the (normalized) content. */
  readonly bytes: number
  /** e-laws consolidation/currency date as ISO YYYY-MM-DD. */
  readonly consolidationDate: string
  /** Licence provenance and reproduction note. */
  readonly licence: LicenceNote
  /** Normalization applied before hashing; defaults to "none". */
  readonly normalization: NormalizationPolicy
}

/** The committed corpus manifest. */
export interface Manifest {
  /** Manifest format version. */
  readonly version: number
  /** ISO timestamp the manifest was generated. */
  readonly generatedAt: string
  /** Every fetched source. */
  readonly sources: readonly ManifestSource[]
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(message: string): never {
  throw new Error(`Invalid corpus manifest: ${message}`)
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${where} field "${key}" must be a non-empty string`)
  }
  return value
}

function parseLicence(value: unknown, where: string): LicenceNote {
  if (!isRecord(value)) {
    fail(`${where} field "licence" must be an object`)
  }
  return {
    holder: requireString(value, 'holder', `${where} licence`),
    note: requireString(value, 'note', `${where} licence`),
  }
}

function parseNormalization(value: unknown, where: string): NormalizationPolicy {
  if (value === undefined) {
    return 'none'
  }
  if (typeof value !== 'string' || !NORMALIZATION_POLICIES.includes(value as NormalizationPolicy)) {
    fail(
      `${where} field "normalization" must be one of ${NORMALIZATION_POLICIES.map((p) => `"${p}"`).join(', ')}`,
    )
  }
  return value as NormalizationPolicy
}

function parseSource(value: unknown, index: number): ManifestSource {
  const where = `sources[${index}]`
  if (!isRecord(value)) {
    fail(`${where} must be an object`)
  }

  const sha256 = requireString(value, 'sha256', where)
  if (!SHA256_PATTERN.test(sha256)) {
    fail(`${where} field "sha256" must be 64 lowercase hex characters`)
  }

  const consolidationDate = requireString(value, 'consolidationDate', where)
  if (!ISO_DATE_PATTERN.test(consolidationDate)) {
    fail(`${where} field "consolidationDate" must be an ISO date (YYYY-MM-DD)`)
  }

  const bytes = value.bytes
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) {
    fail(`${where} field "bytes" must be a non-negative integer`)
  }

  return {
    id: requireString(value, 'id', where),
    title: requireString(value, 'title', where),
    url: requireString(value, 'url', where),
    file: requireString(value, 'file', where),
    sha256,
    bytes,
    consolidationDate,
    licence: parseLicence(value.licence, where),
    normalization: parseNormalization(value.normalization, where),
  }
}

/**
 * Validates an untrusted value as a {@link Manifest}, returning a typed,
 * frozen-by-construction copy. Throws a descriptive Error on the first
 * violation rather than returning a partial result.
 */
export function parseManifest(input: unknown): Manifest {
  if (!isRecord(input)) {
    fail('manifest must be an object')
  }

  const version = input.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    fail('field "version" must be a positive integer')
  }

  const generatedAt = requireString(input, 'generatedAt', 'manifest')

  const rawSources = input.sources
  if (!Array.isArray(rawSources)) {
    fail('field "sources" must be an array')
  }
  if (rawSources.length === 0) {
    fail('"sources" must contain at least one source')
  }

  const sources = rawSources.map(parseSource)

  const seen = new Set<string>()
  for (const source of sources) {
    if (seen.has(source.id)) {
      fail(`duplicate source id "${source.id}"`)
    }
    seen.add(source.id)
  }

  return { version, generatedAt, sources }
}
