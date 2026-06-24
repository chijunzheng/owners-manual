"""RAGAS context-metric wiring tests (issues #18, #46).

RAGAS context metrics (context precision / recall) apply to the RAG arms ONLY —
naive-rag and the agent, which retrieve a context — and NOT to the stuffing arms,
which have no retrieval to measure. These tests assert that gate and the metric
shape against a FAKE evaluator; the live RAGAS binding is lazy-imported, so the
unit suite needs no ragas install.

ADR 0009 pins the seam as ``(question, contexts, reference)`` — the produced
answer and the retrieved path keys are dropped — and adds the pure
``reference_from_answer_points`` helper that synthesizes the reference answer the
two metrics score against from an item's claim-level answer points.
"""

from __future__ import annotations

from owners_manual_evals.golden_item import AnswerPoint
from owners_manual_evals.ragas_metrics import (
    RAG_ARMS,
    ContextMetrics,
    evaluate_context_metrics,
    is_rag_arm,
    reference_from_answer_points,
    scripted_context_evaluator,
)


def test_rag_arms_are_naive_rag_and_agent_only() -> None:
    assert set(RAG_ARMS) == {"naive-rag", "agent"}


def test_is_rag_arm_gates_stuffing_arms_out() -> None:
    assert is_rag_arm("naive-rag") is True
    assert is_rag_arm("agent") is True
    assert is_rag_arm("stuff") is False
    assert is_rag_arm("stuff-oracle") is False


def test_evaluate_returns_metrics_for_a_rag_arm() -> None:
    evaluator = scripted_context_evaluator(context_precision=0.8, context_recall=0.6)
    metrics = evaluate_context_metrics(
        arm="naive-rag",
        question="q",
        contexts=("chunk a", "chunk b"),
        reference="the landlord must keep the unit in repair",
        evaluator=evaluator,
    )
    assert isinstance(metrics, ContextMetrics)
    assert metrics.context_precision == 0.8
    assert metrics.context_recall == 0.6


def test_evaluate_returns_none_for_a_stuffing_arm_no_retrieval_to_measure() -> None:
    evaluator = scripted_context_evaluator(context_precision=0.8, context_recall=0.6)
    metrics = evaluate_context_metrics(
        arm="stuff",
        question="q",
        contexts=("the whole corpus",),
        reference="the landlord must keep the unit in repair",
        evaluator=evaluator,
    )
    # RAGAS does not apply to a no-retrieval arm — the gate returns None and the
    # evaluator is never consulted.
    assert metrics is None


def test_evaluate_does_not_call_the_evaluator_for_a_stuffing_arm() -> None:
    calls: list[str] = []

    def evaluator(*, question: str, contexts, reference: str) -> ContextMetrics:
        calls.append(question)
        return ContextMetrics(context_precision=1.0, context_recall=1.0)

    evaluate_context_metrics(
        arm="stuff-oracle",
        question="q",
        contexts=("x",),
        reference="r",
        evaluator=evaluator,
    )
    assert calls == []


def test_evaluate_forwards_the_reference_to_the_evaluator() -> None:
    # The seam carries the synthesized reference (ADR 0009) — not the produced
    # answer or the retrieved cites — so the evaluator scores retrieval against
    # the hand-verified ground truth.
    seen: dict[str, object] = {}

    def evaluator(*, question: str, contexts, reference: str) -> ContextMetrics:
        seen["question"] = question
        seen["contexts"] = tuple(contexts)
        seen["reference"] = reference
        return ContextMetrics(context_precision=0.5, context_recall=0.5)

    evaluate_context_metrics(
        arm="agent",
        question="who repairs?",
        contexts=("chunk a", "chunk b"),
        reference="the landlord must keep the unit in repair",
        evaluator=evaluator,
    )
    assert seen == {
        "question": "who repairs?",
        "contexts": ("chunk a", "chunk b"),
        "reference": "the landlord must keep the unit in repair",
    }


def test_reference_from_answer_points_newline_joins_point_texts() -> None:
    # The points are already discrete claims; the join hands LLMContextRecall a
    # pre-segmented reference (ADR 0009, Decision 4).
    points = (
        AnswerPoint(id="p1", text="The landlord must keep the unit in good repair."),
        AnswerPoint(id="p2", text="This duty cannot be waived by the lease."),
    )
    reference = reference_from_answer_points(points)
    assert reference == (
        "The landlord must keep the unit in good repair.\nThis duty cannot be waived by the lease."
    )


def test_reference_from_answer_points_single_point_has_no_trailing_newline() -> None:
    points = (AnswerPoint(id="p1", text="The landlord must keep the unit in good repair."),)
    assert reference_from_answer_points(points) == "The landlord must keep the unit in good repair."


def test_reference_from_answer_points_preserves_point_order() -> None:
    points = (
        AnswerPoint(id="p1", text="first"),
        AnswerPoint(id="p2", text="second"),
        AnswerPoint(id="p3", text="third"),
    )
    assert reference_from_answer_points(points) == "first\nsecond\nthird"
