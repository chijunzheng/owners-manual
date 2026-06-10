/**
 * Parse + normalize the self-hosted Langfuse compose file into a typed shape so
 * the stand-up contract (healthy UI, external data volumes, env contract) is
 * machine-checkable in CI without Docker. The compose file is the source of
 * truth; this module is a thin, deterministic reader over it.
 */
import { readFileSync } from 'node:fs'

import { parse } from 'yaml'

/** Env var that roots every Langfuse data bind mount outside the synced repo. */
export const externalDataRootEnvVar = 'LANGFUSE_DATA_ROOT'

/**
 * Marker the data-root guard refuses to write inside of. Living in the synced
 * Google-Drive folder corrupts ClickHouse/Postgres data files, so the guard
 * aborts `compose up` if the resolved data root contains this path segment.
 */
export const REPO_ROOT_MARKER = 'owners-manual'

interface ComposeHealthcheck {
  test?: string | string[]
}

interface ComposeDependency {
  condition?: string
}

export interface ComposeService {
  image?: string
  ports?: string[]
  volumes?: string[]
  command?: string | string[]
  entrypoint?: string | string[]
  healthcheck?: ComposeHealthcheck
  depends_on?: Record<string, ComposeDependency>
}

export interface LangfuseCompose {
  services: Record<string, ComposeService>
  volumes?: Record<string, unknown>
}

/** A single host->container data mount, split into source/target/type. */
export interface DataMountSpec {
  service: string
  source: string
  target: string
  type: 'bind' | 'named'
}

/** Read and parse the compose file at `composePath`. Throws if it is malformed. */
export function loadLangfuseCompose(composePath: string): LangfuseCompose {
  const raw = readFileSync(composePath, 'utf8')
  const parsed = parse(raw) as LangfuseCompose | undefined
  if (!parsed || typeof parsed !== 'object' || !parsed.services) {
    throw new Error(`compose file at ${composePath} has no services block`)
  }
  return parsed
}

/**
 * A mount whose source begins with `.`, `/`, or `${VAR` (an interpolated host
 * path) is a host bind mount; a bare `name:/path` short syntax references an
 * in-VM named volume. The data-volumes contract requires the former.
 */
function classifyMount(source: string): 'bind' | 'named' {
  const isHostPath =
    source.startsWith('/') ||
    source.startsWith('.') ||
    source.startsWith('~') ||
    source.startsWith('${')
  return isHostPath ? 'bind' : 'named'
}

/**
 * Split a compose short-syntax volume entry (`source:target[:mode]`) on the
 * colons that separate fields, while treating colons inside `${...}` shell
 * interpolation (e.g. the `:-` of `${VAR:-default}`) as part of the source.
 * Returns `[source, target]` or `null` for anonymous/malformed entries.
 */
export function splitVolumeEntry(entry: string): [string, string] | null {
  const fields: string[] = []
  let current = ''
  let braceDepth = 0
  for (let i = 0; i < entry.length; i += 1) {
    const ch = entry[i]
    if (ch === '{') braceDepth += 1
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1)
    if (ch === ':' && braceDepth === 0) {
      fields.push(current)
      current = ''
      continue
    }
    current += ch
  }
  fields.push(current)

  const [source, target] = fields
  if (!source || !target) return null
  return [source, target]
}

/**
 * Flatten every service's `volumes:` short-syntax entries into typed specs,
 * dropping anonymous volumes (single-field entries with no `source:target`).
 */
export function composeDataMountSpecs(composePath: string): DataMountSpec[] {
  const compose = loadLangfuseCompose(composePath)
  const specs: DataMountSpec[] = []
  for (const [service, def] of Object.entries(compose.services)) {
    for (const entry of def.volumes ?? []) {
      const parts = splitVolumeEntry(entry)
      if (!parts) continue
      const [source, target] = parts
      specs.push({ service, source, target, type: classifyMount(source) })
    }
  }
  return specs
}
