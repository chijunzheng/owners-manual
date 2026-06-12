# Provider split by workload shape: Vertex Gemini at runtime, Claude for offline batch

Supersedes the product-path default in [ADR 0001](./0001-claude-agent-sdk-adapter-as-default-llm-provider.md) (2026-06-10).

Two free budgets exist with different shapes: a $400 GCP free-trial credit on a 90-day clock (live today), and the Claude Max Agent SDK credit ($100/month, starts 2026-06-15, covers SDK/`claude -p` usage only). The split assigns each budget the workload it naturally fits:

- **Runtime (GCP credit)** — the LangGraph agent and **all four eval arms** run Gemini on Vertex AI via the stock `ChatVertexAI` provider. Holding the model constant across arms is an eval invariant: arm gaps measure architecture, never model choice. Stuffing arms ride Vertex context caching.
- **Offline batch (SDK credit)** — ingestion enrichment (tree-level and chunk-level, per ADR 0004's Claude PDF track) and the **primary LLM judge** run Claude via `claude -p` / Agent SDK. Enrichment invokes Claude per document with chunks batched (never one subprocess per chunk); the enrichment model string is pinned in pipeline config and therefore in the corpus-build hash.

The judge design flips and strengthens: with Gemini as the product model, Claude judging all arms is **cross-family by default on every item** — self-preference bias (Panickssery et al.) has no purchase on headline numbers. Gemini becomes the *same-family* secondary judge on the calibration slice.

## Why Vertex AI and not the Gemini Developer API

The GCP free-trial credit explicitly **cannot** pay for "Gemini API in AI Studio" (exclusion tightened March 2026), and AI Studio Tier 1 now requires a real-money prepay. The credit also excludes partner MaaS models (so Claude-on-Vertex is not a judge path). Google's own Gemini on Vertex AI is a covered first-party service. Vertex pay-as-you-go uses **dynamic shared quota**: no fixed per-project RPM/TPM, transient 429s under regional load handled by retries — a non-event for a sequential eval harness.

## Considered Options

- **Full Gemini engine** (enrichment on Gemini too): one provider everywhere, but burns 90-day credit on offline work the subscription does free, and idles the SDK credit.
- **Keep Claude engine** (ADR 0001 as written): conservative, but most of the $400 expires unused, the custom adapter stays on the critical path, and cross-family judging stays confined to the 20-item slice.
- **AI Studio paid tier**: simplest SDK, but the credit doesn't apply — real money while $400 sits idle.

## Consequences

- `ChatVertexAI` replaces the custom Agent SDK adapter on the critical path; the adapter is demoted to stretch goal / post-credit fallback, keeping the provider-swap story demonstrable.
- The 90-day credit window becomes a scheduling constraint: matrix runs, ladders, and stuffing arms land inside it (check Billing console for days remaining; set budget alerts before upgrading the account).
- Free-trial accounts can't request quota increases — irrelevant under dynamic shared quota.
- The AI Studio free tier is never used for anything touching BYOD/personal documents (free-tier prompts may be used for model training).
- Smoke-tier CI runs bill to Vertex via a CI service account; the `claude setup-token` verify flag moves to the judge path (nightly tier).
- Embeddings still bill outside both credits (Voyage/OpenAI); an optional `gemini-embedding` third A/B arm could ride the GCP credit. *(2026-06-12, #6: that optional arm was promoted — the embedding B arm is `gemini-embedding-001` on Vertex, and OpenAI is dropped from the provider inventory entirely; only the Voyage A arm bills outside the credits.)*
- Verify at build: current Gemini context window covers the ~900K `stuff` arm; Vertex long-context and context-caching pricing.
