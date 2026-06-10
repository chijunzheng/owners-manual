# Claude Agent SDK adapter as the default LLM provider

> **Superseded in part by [ADR 0005](./0005-provider-split-vertex-gemini-runtime-claude-offline-batch.md)** (2026-06-10): the product/runtime path moved to Gemini on Vertex AI; the SDK adapter is now a stretch goal / post-credit fallback. The SDK-credit rationale below still governs the offline-batch path (ingestion enrichment + judge).

The agent is orchestrated by LangGraph.js behind a swappable ChatModel interface with two providers: a custom LangChain.js adapter wrapping the Claude Agent SDK (subscription auth), and `ChatAnthropic` (API key). The adapter is the default for dev loops, eval runs, and the working demo because Claude Max includes a monthly Agent SDK credit ($100 on Max 5x, effective 2026-06-15) that covers SDK-authenticated usage but not direct API calls — and eval runs (hundreds of LLM-judge calls per experiment) are the dominant token cost. `ChatAnthropic` stays wired and exercised (~$5-10 of spend) to prove provider-level streaming and function-calling management.

## Considered Options

- Pure API (`ChatAnthropic` only): simplest, but every eval iteration bills pay-as-you-go.
- Pure Agent SDK engine (no LangGraph): $0 marginal cost but forfeits the orchestration-framework evidence and hides streaming/function-calling management inside Anthropic's loop.

## Consequences

- Embeddings cannot ride the credit (Anthropic has no embeddings API) — they bill to OpenAI/Voyage regardless.
- The adapter must degrade gracefully when the monthly credit is exhausted (spillover only occurs if usage credits are enabled; otherwise SDK calls stop until reset).
