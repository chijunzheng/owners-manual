"""The live RAGAS evaluator binding (issue #18): context metrics for RAG arms.

RAGAS context-precision / context-recall over a RAG arm's retrieved context,
evaluated against the SAME Gemini product model (ADR 0005). Live-by-design and
NOT unit-tested: the gate that restricts RAGAS to the RAG arms and the metric
shape are covered upstream against the scripted evaluator
(:func:`scripted_context_evaluator`). ``ragas`` is imported lazily so it stays out
of the unit suite's dependency surface (the install is heavy; the offline tests
never need it), matching the Langfuse / Agent-SDK lazy-import convention.

OPEN QUESTION (surfaced, not hardcoded): RAGAS is not yet a declared dependency in
``pyproject.toml`` and the exact RAGAS-on-Vertex wiring (which RAGAS metrics, which
LLM/embedding wrapper) is provisional — to be pinned when the RAG-only context
columns go live. The judge and the dashboard do not depend on this binding; the
four-arm table renders RAG-only markers without it.
"""

from __future__ import annotations

from collections.abc import Sequence

from .ragas_metrics import ContextEvaluator, ContextMetrics


def build_ragas_context_evaluator() -> ContextEvaluator:  # pragma: no cover - live by design
    """Build the live RAGAS context evaluator (context precision/recall).

    Raises ``RuntimeError`` with install guidance if ``ragas`` is not present —
    the four-arm table works without it (RAG columns render RAG-only / blank), so
    this binding is only constructed when the live RAGAS columns are wanted.
    """
    try:
        import ragas  # noqa: F401, PLC0415
    except ImportError as error:
        raise RuntimeError(
            "ragas is not installed. Add it to the evals dependency group and pin the "
            "RAGAS-on-Vertex wiring (see ragas_live OPEN QUESTION) before enabling the "
            "live RAG-only context columns; tests mock the evaluator seam."
        ) from error

    def evaluator(
        *,
        question: str,
        contexts: Sequence[str],
        answer: str,
        required_cites: Sequence[str],
    ) -> ContextMetrics:
        # Provisional: map the harness inputs onto a RAGAS single-sample evaluation
        # over the Gemini product model. Pinned when the columns go live.
        raise NotImplementedError(
            "live RAGAS wiring is provisional — pin metrics + Vertex wrapper in an ADR first"
        )

    return evaluator


__all__ = ["build_ragas_context_evaluator"]
