/**
 * Public surface of the corpus-acquisition package: the manifest schema, the
 * checksum/normalization primitives, the byte-source abstractions, and the
 * verify/rebuild engines. The CLI (`./cli.ts`) composes these; downstream
 * ingestion code imports the manifest types from here.
 */

export { parseManifest } from './manifest/schema.js'
export type {
  LicenceNote,
  Manifest,
  ManifestSource,
  NormalizationPolicy,
} from './manifest/schema.js'

export { checksum, sha256Hex } from './hash.js'
export type { Checksum } from './hash.js'

export { normalizeBytes } from './normalize.js'

export { verifyManifest, summarize } from './verify.js'
export type { ByteSource, SourceResult, VerifyReport } from './verify.js'

export { rebuild } from './rebuild.js'
export { renderReport } from './report.js'

export { curlByteSource, buildCurlArgs, spawnCurl } from './curl.js'
export type { CurlResult, CurlRunner } from './curl.js'

export { loadManifest, writeSource, diskByteSource } from './storage.js'
