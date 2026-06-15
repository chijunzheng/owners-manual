"""RAGAS context-metric wiring tests (issue #18).

RAGAS context metrics (context precision / recall) apply to the RAG arms ONLY —
naive-rag and the agent, which retrieve a context — and NOT to the stuffing arms,
which have no retrieval to measure. These tests assert that gate and the metric
shape against a FAKE evaluator; the live RAGAS binding is lazy-imported, so the
unit suite needs no ragas install.
"""

from __future__ import annotations

from owners_manual_evals.ragas_metrics import (
    RAG_ARMS,
    ContextMetrics,
    evaluate_context_metrics,
    is_rag_arm,
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
        answer="a",
        required_cites=("rta-2006|section:20",),
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
        answer="a",
        required_cites=("rta-2006|section:20",),
        evaluator=evaluator,
    )
    # RAGAS does not apply to a no-retrieval arm — the gate returns None and the
    # evaluator is never consulted.
    assert metrics is None


def test_evaluate_does_not_call_the_evaluator_for_a_stuffing_arm() -> None:
    calls: list[str] = []

    def evaluator(*, question: str, contexts, answer: str, required_cites) -> ContextMetrics:
        calls.append(question)
        return ContextMetrics(context_precision=1.0, context_recall=1.0)

    evaluate_context_metrics(
        arm="stuff-oracle",
        question="q",
        contexts=("x",),
        answer="a",
        required_cites=(),
        evaluator=evaluator,
    )
    assert calls == []
