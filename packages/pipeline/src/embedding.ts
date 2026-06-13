/**
 * The embedding seam — a small interface so the #14 A/B swap (voyage-law-2 vs
 * gemini-embedding-001) is config, not surgery (orchestrator pin for #10).
 *
 * The naive-rag arm embeds with `voyage-law-2` (1024-dim, legal-tuned) via the
 * Voyage REST API behind {@link EmbeddingProvider}. Both the index build and the
 * query path consume the interface, never the concrete client, so #14 registers
 * a Vertex `gemini-embedding-001` provider and flips a config field with no
 * change to retrieval or ingestion code.
 *
 * The HTTP call is injected ({@link VoyageFetch}) so the unit suite exercises the
 * batching, input-type, and dimension-guard logic with a fake — the live path is
 * the CLI's job, matching the providers-package pattern (no live network in
 * vitest). The api key is sent as a bearer token and never appears in an error.
 */

/** The provider-agnostic embedding contract every arm's retrieval rides. */
export interface EmbeddingProvider {
  /** The embedding model string — recorded in the pipeline config + index. */
  readonly model: string
  /** The vector dimension the Atlas index is built for. */
  readonly dimensions: number
  /** Embed a batch of documents (corpus chunks), in input order. */
  embedDocuments(texts: readonly string[]): Promise<number[][]>
  /** Embed one query string. */
  embedQuery(text: string): Promise<number[]>
}

/** The minimal `fetch` shape this module needs — injectable for tests. */
export type VoyageFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}>

export interface VoyageEmbeddingOptions {
  readonly apiKey: string
  readonly model: string
  readonly dimensions: number
  /** Injected HTTP client; defaults to the global `fetch`. */
  readonly fetch?: VoyageFetch
  /**
   * Max retries on a 429 (rate limit). Voyage's free tier is 3 RPM until a
   * payment method is added, so the one-time ingest leans on this. Default 6.
   */
  readonly maxRetries?: number
  /** Injected delay (ms); defaults to a real timer. Lets tests run instantly. */
  readonly sleep?: (ms: number) => Promise<void>
}

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings'

/** Base backoff for a 429 — exponential, capped, jittered. */
const BASE_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000

const defaultFetch: VoyageFetch = async (url, init) => {
  const response = await fetch(url, init)
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
    text: () => response.text(),
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

interface VoyageResponse {
  data?: ReadonlyArray<{ embedding?: readonly number[] }>
}

/**
 * Construct a Voyage-backed {@link EmbeddingProvider}. Documents and queries
 * hit the same endpoint with the appropriate `input_type` (Voyage embeds the
 * two asymmetrically). A 429 is retried with exponential backoff (the free-tier
 * 3-RPM cap is the common case for the one-time ingest); other errors fail
 * fast. Every returned vector is checked against the configured dimension so a
 * model/index mismatch fails loudly at embed time, not silently at search time.
 */
export function createVoyageEmbeddingProvider(options: VoyageEmbeddingOptions): EmbeddingProvider {
  const { apiKey, model, dimensions } = options
  const doFetch = options.fetch ?? defaultFetch
  const sleep = options.sleep ?? defaultSleep
  const maxRetries = options.maxRetries ?? 6

  async function callOnce(texts: readonly string[], inputType: 'document' | 'query') {
    return doFetch(VOYAGE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, input: texts, input_type: inputType }),
    })
  }

  async function embed(
    texts: readonly string[],
    inputType: 'document' | 'query',
  ): Promise<number[][]> {
    if (texts.length === 0) return []

    let response = await callOnce(texts, inputType)
    for (let attempt = 0; response.status === 429 && attempt < maxRetries; attempt += 1) {
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
      const jitter = Math.floor(Math.random() * 250)
      await sleep(backoff + jitter)
      response = await callOnce(texts, inputType)
    }

    if (!response.ok) {
      const body = (await response.text()).slice(0, 120)
      throw new Error(`Voyage embeddings HTTP ${response.status}: ${body}`)
    }
    const json = (await response.json()) as VoyageResponse
    const rows = json.data ?? []
    if (rows.length !== texts.length) {
      throw new Error(`Voyage returned ${rows.length} vectors for ${texts.length} inputs`)
    }
    return rows.map((row, index) => {
      const vector = row.embedding
      if (!vector || vector.length !== dimensions) {
        throw new Error(
          `Voyage vector ${index} has dimension ${vector?.length ?? 0}, expected ${dimensions}`,
        )
      }
      return [...vector]
    })
  }

  return {
    model,
    dimensions,
    embedDocuments: (texts) => embed(texts, 'document'),
    async embedQuery(text) {
      const [vector] = await embed([text], 'query')
      if (!vector) throw new Error('Voyage returned no vector for the query')
      return vector
    },
  }
}
