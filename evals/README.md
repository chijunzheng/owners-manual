# owners-manual-evals

Python eval harness for [owners-manual](../README.md). Per
[ADR 0003](../docs/adr/0003-typescript-product-python-evals-split.md), the
TypeScript product owns the serving path and this package owns the eval
harness — golden/adversarial datasets, citation-accuracy scoring, RAGAS, and
Langfuse Datasets/Experiments — treating the TS service as a black box over
HTTP plus Langfuse traces.

This is a Phase-0 scaffold: one passing placeholder test wired into CI. The
golden-set loader, metrics, and Langfuse integration land in later issues.

## Develop

```bash
uv sync          # install dev deps into .venv
uv run pytest    # run the suite
uv run ruff check .
```
