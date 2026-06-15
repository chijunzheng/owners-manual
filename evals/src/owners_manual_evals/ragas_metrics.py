"""RAGAS context metrics, for the RAG arms ONLY (issue #18).

RAGAS context-precision / context-recall measure how well a RETRIEVED context
serves the answer. They are meaningful for the RAG arms — naive-rag and the agent,
which retrieve a top-k context — and meaningless for the stuffing arms, which have
no retrieval to measure (the whole corpus is "retrieved" by construction). So this
module gates RAGAS to :data:`RAG_ARMS` and returns ``None`` for the stuffing arms;
the four-arm dashboard marks the columns RAG-only and leaves the stuffing rows
blank, never blending a stuffing arm into a context metric.

The RAGAS computation is injected behind the :class:`ContextEvaluator` seam, so
this module is pure and unit-tested with a fake. The live binding lazy-imports
``ragas`` (kept out of the unit suite's dependency surface, like Langfuse and the
Agent SDK) and runs it against the same Gemini product model.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

#: The arms RAGAS context metrics apply to — the ones that retrieve a context.
RAG_ARMS: tuple[str, ...] = ("naive-rag", "agent")


@dataclass(frozen=True, slots=True)
class ContextMetrics:
    """RAGAS context precision/recall for one RAG-arm answer, each in ``[0, 1]``."""

    context_precision: float
    context_recall: float


class ContextEvaluator(Protocol):
    """The slice of a RAGAS evaluator this module needs — injectable for tests."""

    def __call__(
        self,
        *,
        question: str,
        contexts: Sequence[str],
        answer: str,
        required_cites: Sequence[str],
    ) -> ContextMetrics: ...


def is_rag_arm(arm: str) -> bool:
    """True for an arm that retrieves a context (naive-rag, agent); False for the
    stuffing arms, which have no retrieval for RAGAS to measure."""
    return arm in RAG_ARMS


def evaluate_context_metrics(
    *,
    arm: str,
    question: str,
    contexts: Sequence[str],
    answer: str,
    required_cites: Sequence[str],
    evaluator: ContextEvaluator,
) -> ContextMetrics | None:
    """Evaluate RAGAS context metrics for a RAG arm; return ``None`` (and never
    consult the evaluator) for a stuffing arm."""
    if not is_rag_arm(arm):
        return None
    return evaluator(
        question=question,
        contexts=contexts,
        answer=answer,
        required_cites=required_cites,
    )


def scripted_context_evaluator(
    *,
    context_precision: float,
    context_recall: float,
) -> ContextEvaluator:
    """A fixed-output fake evaluator for the unit suite (no ragas install)."""

    def evaluator(
        *,
        question: str,
        contexts: Sequence[str],
        answer: str,
        required_cites: Sequence[str],
    ) -> ContextMetrics:
        _ = (question, contexts, answer, required_cites)
        return ContextMetrics(
            context_precision=context_precision,
            context_recall=context_recall,
        )

    return evaluator


__all__ = [
    "RAG_ARMS",
    "ContextMetrics",
    "ContextEvaluator",
    "is_rag_arm",
    "evaluate_context_metrics",
    "scripted_context_evaluator",
]
