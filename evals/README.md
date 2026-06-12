# owners-manual-evals

Python eval harness for [owners-manual](../README.md). Per
[ADR 0003](../docs/adr/0003-typescript-product-python-evals-split.md), the
TypeScript product owns the serving path and this package owns the eval
harness — golden/adversarial datasets, citation-accuracy scoring, RAGAS, and
Langfuse Datasets/Experiments — treating the TS service as a black box over
HTTP plus Langfuse traces.

## Naive-RAG arm: the first scored dashboard (issue #10)

The tracer-bullet arm runs golden v0 through the naive-rag pipeline (fixed-size
citable-unit chunks → voyage-law-2 embeddings → Atlas vector search → plain
Vertex-Gemini synthesis under the structured answer envelope) and prints the
first score dashboard: strict pass rate (headline), citation precision/recall,
retrieval hit rate, and cost/latency — per behavior-class slice, never averaged.

```bash
# 1. One-time corpus build (chunk + embed + create the single Atlas index).
#    Lives in the TS pipeline package; reads the gitignored corpus/raw bytes.
pnpm --filter @owners-manual/pipeline run naive-rag:ingest

# 2. Start the naive-rag HTTP service the harness drives (separate terminal).
pnpm --filter @owners-manual/pipeline run naive-rag:serve

# 3. The one command: run golden v0 (dev split) and print the dashboard.
cd evals && uv run run-naive-rag                  # dev split only (holdout sealed)
cd evals && uv run run-naive-rag --include-holdout # also run the sealed holdout
```

Trace-id propagation (AC2): the harness derives a deterministic trace id per
item, opens a Langfuse span under it, and POSTs the trace id (body + W3C
`traceparent` header) to the service, which reuses it verbatim — so the harness
span and the service's retrieve/synthesize spans collapse into one nested trace
in Langfuse. Deterministic scores are written back via `create_score(trace_id=…)`.

## Develop

```bash
uv sync          # install dev deps into .venv
uv run pytest    # run the suite
uv run ruff check .
```
