"""The live RAGAS evaluator binding (issues #18, #46): context metrics for RAG arms.

RAGAS context-precision / context-recall over a RAG arm's retrieved context,
evaluated against the Gemini product model on Vertex (ADR 0005). Live-by-design and
NOT unit-tested: the gate that restricts RAGAS to the RAG arms and the metric
shape are covered upstream against the scripted evaluator
(:func:`scripted_context_evaluator`). ``ragas`` (and its ``langchain-google-vertexai``
peer) are imported lazily so they stay out of the unit suite's dependency surface
(the install is heavy; the offline tests never need it), matching the Langfuse /
Agent-SDK lazy-import convention.

ADR 0009 settles the wiring this module once flagged as open:

* **Anchor — reference-based on the golden answer points.** One reference answer is
  synthesized per item (:func:`reference_from_answer_points`) and the retrieved
  context is scored against it with ``LLMContextPrecisionWithReference`` (each
  chunk's usefulness toward the reference) + ``LLMContextRecall`` (each reference
  claim's attribution to the context). This is the only anchor that fills BOTH
  committed columns from the hand-verified ground truth.
* **Evaluator LLM — Gemini on Vertex via RAGAS's LangChain wrapper.** A
  ``ChatVertexAI`` (the ADR 0005 Vertex provider) wrapped in
  ``LangchainLLMWrapper``; the model string is read from a dedicated
  ``RAGAS_VERTEX_MODEL`` env var (fail loud if unset, mirroring ADR 0008's
  ``JUDGE_CLAUDE_MODEL``). Both metrics are LLM-only, so NO embedding wrapper and
  no embedding dependency.
* **Per-item, with a sync boundary.** One item per evaluation (``single_turn_ascore``),
  preserving per-item independence as the judge does; the async RAGAS call is
  bridged to the synchronous :class:`ContextEvaluator` seam INSIDE this binding, so
  the four-arm loop stays synchronous.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Sequence

from .ragas_metrics import ContextEvaluator, ContextMetrics

#: The Vertex model string for RAGAS's evaluator LLM, read from the environment
#: (ADR 0009). MAY be the product ``DEFAULT_MODEL`` but is pinned independently —
#: never hardcoded, mirroring ``JUDGE_CLAUDE_MODEL`` (ADR 0008).
_RAGAS_VERTEX_MODEL_ENV = "RAGAS_VERTEX_MODEL"


def build_ragas_context_evaluator() -> ContextEvaluator:  # pragma: no cover - live by design
    """Build the live RAGAS context evaluator (context precision/recall, ADR 0009).

    Raises ``RuntimeError`` with install guidance if ``ragas`` /
    ``langchain-google-vertexai`` are not present (the lazy/optional ``ragas``
    dependency group is not installed) — the four-arm table works without this
    binding (RAG columns render RAG-only / blank), so it is only constructed when
    the live RAGAS columns are wanted. Raises ``RuntimeError`` if
    ``RAGAS_VERTEX_MODEL`` is unset, rather than silently falling back — a
    misconfigured evaluator should fail loud at the start of a run, not score
    garbage.
    """
    model = os.environ.get(_RAGAS_VERTEX_MODEL_ENV)
    if not model:
        raise RuntimeError(
            f"{_RAGAS_VERTEX_MODEL_ENV} is not set. Pin the RAGAS evaluator model in .env "
            "(the Gemini-on-Vertex product model, ADR 0005) before enabling the live RAG-only "
            "context columns; tests mock the evaluator seam."
        )

    try:
        from langchain_google_vertexai import ChatVertexAI  # noqa: PLC0415
        from ragas.dataset_schema import SingleTurnSample  # noqa: PLC0415
        from ragas.llms import LangchainLLMWrapper  # noqa: PLC0415
        from ragas.metrics import (  # noqa: PLC0415
            LLMContextPrecisionWithReference,
            LLMContextRecall,
        )
    except ImportError as error:
        raise RuntimeError(
            "ragas (and its langchain-google-vertexai peer) is not installed. Install the "
            "evals 'ragas' optional dependency group (e.g. `uv sync --group ragas`) before "
            "enabling the live RAG-only context columns; the offline unit suite mocks the "
            "evaluator seam and needs neither."
        ) from error

    # LLM-only (ADR 0009 Decision 5): the Gemini-on-Vertex provider wrapped for
    # RAGAS. No embedding wrapper — both chosen metrics are LLM-scored, so RAGAS
    # adds no embedding dependency and no embedding cost.
    evaluator_llm = LangchainLLMWrapper(ChatVertexAI(model=model))
    precision = LLMContextPrecisionWithReference(llm=evaluator_llm)
    recall = LLMContextRecall(llm=evaluator_llm)

    def evaluator(
        *,
        question: str,
        contexts: Sequence[str],
        reference: str,
    ) -> ContextMetrics:
        # One item per RAGAS evaluation (per-item independence, like the judge).
        sample = SingleTurnSample(
            user_input=question,
            retrieved_contexts=list(contexts),
            reference=reference,
        )

        # Bridge the async RAGAS score to the synchronous seam INSIDE the binding,
        # so the four-arm loop and the ContextEvaluator stay synchronous.
        async def _score() -> ContextMetrics:
            return ContextMetrics(
                context_precision=await precision.single_turn_ascore(sample),
                context_recall=await recall.single_turn_ascore(sample),
            )

        return asyncio.run(_score())

    return evaluator


__all__ = ["build_ragas_context_evaluator"]
