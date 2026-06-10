# TypeScript owns the product; Python owns the eval harness

Everything in the serving path — ingestion CLI, hierarchy-aware chunker, LangGraph.js agent, SSE API, Mongo integration, the Agent SDK adapter — is TypeScript. The eval harness — golden/adversarial datasets, RAGAS metrics, custom citation-accuracy scoring, Langfuse Datasets/Experiments — is Python, and treats the TS service as a black box over HTTP plus Langfuse traces. The boundary is deliberate: it forces depth in TypeScript (where the portfolio is thin) while keeping the eval ecosystem (RAGAS, Langfuse SDK maturity) where it is strongest, and black-box evals mean the harness measures what users actually get, not internal functions.

## Consequences

- Retrieval-only metrics (precision@k before synthesis) need a debug endpoint on the TS service that exposes ranked chunks; this endpoint is part of the contract, not a hack.
- Two toolchains in one repo: pnpm workspace + uv-managed `evals/` package, each with its own CI job.
