"""Four-arm comparison runner tests (issue #18).

The one command that produces the full four-arm score table: it runs the SAME
golden items through stuff, stuff-oracle, naive-rag, and agent (paired by item),
scores each deterministically, runs the offline judge against each produced answer
(joining its verdicts to the exact trace), evaluates RAGAS context metrics for the
RAG arms only, and builds the four-arm dashboard. The judge and the RAGAS evaluator
are injected, so the whole loop is unit-tested offline against fakes — never a live
model.
"""

from __future__ import annotations

from owners_manual_evals.citable_path import CitablePath, CitablePathSegment
from owners_manual_evals.compare_four_arms import run_four_arm_comparison
from owners_manual_evals.document_tree import parse_document_tree
from owners_manual_evals.golden_item import parse_golden_item
from owners_manual_evals.judge import scripted_judge
from owners_manual_evals.ragas_metrics import scripted_context_evaluator
from owners_manual_evals.run_naive_rag import ItemOutcome

_TREE = parse_document_tree(
    {
        "kind": "document",
        "documentId": "rta-2006",
        "label": "RTA",
        "children": [
            {
                "kind": "part",
                "label": "III",
                "children": [
                    {
                        "kind": "section",
                        "label": "20",
                        "children": [{"kind": "subsection", "label": "1", "children": []}],
                    }
                ],
            }
        ],
    }
)
_DOCUMENTS = (_TREE,)


def _path() -> CitablePath:
    return CitablePath(
        document_id="rta-2006",
        segments=(
            CitablePathSegment("part", "III"),
            CitablePathSegment("section", "20"),
            CitablePathSegment("subsection", "1"),
        ),
    )


def _item(item_id: str) -> object:
    return parse_golden_item(
        {
            "id": item_id,
            "behavior_class": "answer",
            "corpus": "tenancy",
            "verified": True,
            "question": f"Q {item_id}",
            "answer_points": [{"id": "p1", "text": "the duty"}],
            "required_cites": [
                {
                    "documentId": "rta-2006",
                    "segments": [
                        {"kind": "part", "label": "III"},
                        {"kind": "section", "label": "20"},
                        {"kind": "subsection", "label": "1"},
                    ],
                }
            ],
            "provenance": {"source": "statute", "reference": "x"},
        },
        documents=_DOCUMENTS,
    )


def _outcome(item: object, *, trace_seed: str) -> ItemOutcome:
    return ItemOutcome(
        item_id=item.id,  # type: ignore[attr-defined]
        observed_behavior="answer",
        candidate_cites=(_path(),),
        retrieved_path_keys=("rta-2006|part:III|section:20|subsection:1",),
        latency_ms={"total": 100.0},
        cost_usd=0.01,
        trace_id=f"{trace_seed}:{item.id}",  # type: ignore[attr-defined]
        answer_text="The landlord must keep the unit in repair.",
    )


def _arm_fn(trace_seed: str):
    def answer(item: object) -> ItemOutcome:
        return _outcome(item, trace_seed=trace_seed)

    return answer


def _judge():
    return scripted_judge({"p1": True})


def _evaluator():
    return scripted_context_evaluator(context_precision=0.9, context_recall=0.8)


def _run(score_sink=lambda **_kw: None):
    items = (_item("a1"), _item("a2"))
    return run_four_arm_comparison(
        items=items,
        documents=_DOCUMENTS,
        answers={
            "stuff": _arm_fn("stuff"),
            "stuff-oracle": _arm_fn("oracle"),
            "naive-rag": _arm_fn("naive"),
            "agent": _arm_fn("agent"),
        },
        contexts_by_arm={
            "naive-rag": {"a1": ("ctx",), "a2": ("ctx",)},
            "agent": {"a1": ("ctx",), "a2": ("ctx",)},
        },
        judge_client=_judge(),
        context_evaluator=_evaluator(),
        score_sink=score_sink,
    )


def test_builds_a_four_arm_dashboard_over_the_same_items() -> None:
    result = _run()
    assert tuple(result.dashboard.arm_order) == ("stuff", "stuff-oracle", "naive-rag", "agent")
    assert {i.id for i in result.items} == {"a1", "a2"}


def test_judge_point_score_appears_per_arm() -> None:
    result = _run()
    by_arm = {row.arm: row for row in result.dashboard.overall}
    assert by_arm["stuff"].point_score == 1.0  # the scripted judge credits p1


def test_ragas_columns_for_rag_arms_only() -> None:
    result = _run()
    by_arm = {row.arm: row for row in result.dashboard.overall}
    assert by_arm["naive-rag"].context_recall == 0.8
    assert by_arm["agent"].context_recall == 0.8
    assert by_arm["stuff"].context_recall is None
    assert by_arm["stuff-oracle"].context_recall is None


def test_ragas_evaluator_is_handed_the_reference_synthesized_from_answer_points() -> None:
    # ADR 0009: the call site builds reference=reference_from_answer_points(item
    # .answer_points) and drops the produced answer / required cites. The evaluator
    # must receive that reference (the hand-verified ground truth), NOT the
    # produced answer_text.
    seen: list[dict[str, object]] = []

    def evaluator(*, question: str, contexts, reference: str):
        from owners_manual_evals.ragas_metrics import ContextMetrics

        seen.append({"question": question, "reference": reference})
        return ContextMetrics(context_precision=0.9, context_recall=0.8)

    items = (_item("a1"),)
    run_four_arm_comparison(
        items=items,
        documents=_DOCUMENTS,
        answers={
            "stuff": _arm_fn("stuff"),
            "stuff-oracle": _arm_fn("oracle"),
            "naive-rag": _arm_fn("naive"),
            "agent": _arm_fn("agent"),
        },
        contexts_by_arm={
            "naive-rag": {"a1": ("ctx",)},
            "agent": {"a1": ("ctx",)},
        },
        judge_client=_judge(),
        context_evaluator=evaluator,
        score_sink=lambda **_kw: None,
    )
    # Only the two RAG arms consult the evaluator; the reference is the joined
    # answer-point text ("the duty"), never the produced answer.
    assert len(seen) == 2
    assert all(call["reference"] == "the duty" for call in seen)
    assert all("repair" not in str(call["reference"]) for call in seen)


def test_judge_scores_are_written_joined_to_each_arms_trace() -> None:
    captured: list[dict] = []

    def sink(**kwargs: object) -> None:
        captured.append(dict(kwargs))

    _run(sink)
    # The judge point score is written for each arm's distinct trace per item.
    judge_traces = {c["trace_id"] for c in captured if c["name"] == "judge_point_score"}
    assert "stuff:a1" in judge_traces
    assert "agent:a2" in judge_traces


def test_deterministic_scores_still_written_beside_the_judge() -> None:
    captured: list[dict] = []

    def sink(**kwargs: object) -> None:
        captured.append(dict(kwargs))

    _run(sink)
    names = {c["name"] for c in captured}
    # Both families of score land on the traces (judge BESIDE deterministic).
    assert "strict_pass" in names
    assert "judge_point_score" in names


def test_runs_without_a_context_evaluator_when_ragas_is_disabled() -> None:
    # RAGAS is opt-in: with no evaluator the four-arm comparison still runs (the
    # RAG columns simply carry no RAGAS metrics) instead of the live RAGAS build
    # crashing the whole table before any arm runs.
    items = (_item("a1"), _item("a2"))
    result = run_four_arm_comparison(
        items=items,
        documents=_DOCUMENTS,
        answers={
            "stuff": _arm_fn("stuff"),
            "stuff-oracle": _arm_fn("oracle"),
            "naive-rag": _arm_fn("naive"),
            "agent": _arm_fn("agent"),
        },
        contexts_by_arm={},
        judge_client=_judge(),
        context_evaluator=None,
        score_sink=lambda **_kw: None,
    )
    assert len(result.items) == 2
    assert result.dashboard is not None


def test_exposes_per_arm_scores_for_the_disposition_ritual() -> None:
    # The disposition ritual (issue #21) enqueues a chosen arm's failures; the
    # four-arm result must expose the per-arm deterministic scores so the ritual
    # can read them without re-running or reaching into the aggregated dashboard.
    result = _run()
    assert set(result.scores_by_arm) == {"stuff", "stuff-oracle", "naive-rag", "agent"}
    agent_scores = result.scores_by_arm["agent"]
    assert {s.item_id for s in agent_scores} == {"a1", "a2"}


def test_rejects_an_arm_with_a_missing_answer_function() -> None:
    items = (_item("a1"),)
    try:
        run_four_arm_comparison(
            items=items,
            documents=_DOCUMENTS,
            answers={"stuff": _arm_fn("stuff")},  # missing the other three arms
            contexts_by_arm={},
            judge_client=_judge(),
            context_evaluator=_evaluator(),
            score_sink=lambda **_kw: None,
        )
    except ValueError as error:
        assert "arm" in str(error).lower()
    else:  # pragma: no cover
        raise AssertionError("expected a ValueError for missing arms")
