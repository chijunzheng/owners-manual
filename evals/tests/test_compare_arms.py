"""Paired arm-comparison runner tests (issue #15 AC4).

Pins the comparison orchestration without a live service: two fake answer
functions (one per arm) stand in for the HTTP+SSE paths, and a fake score sink
captures what the harness would write to Langfuse. The runner selects the items
once, runs the SAME set through both arms, scores each deterministically, and
builds the paired agent-vs-naive-rag dashboard — so the strict-pass delta is over
one shared item set, paired by id.
"""

from __future__ import annotations

from owners_manual_evals.citable_path import CitablePath, CitablePathSegment
from owners_manual_evals.compare_arms import run_comparison
from owners_manual_evals.document_tree import parse_document_tree
from owners_manual_evals.golden_item import parse_golden_item
from owners_manual_evals.golden_loader import GoldenSet
from owners_manual_evals.run_naive_rag import ItemOutcome, select_run_items

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


def _answer_item(item_id: str) -> object:
    return parse_golden_item(
        {
            "id": item_id,
            "behavior_class": "answer",
            "verified": True,
            "question": f"Q {item_id}",
            "answer_points": [{"id": "p1", "text": "t"}],
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


def _set(*items: object) -> GoldenSet:
    return GoldenSet(version=1, items=tuple(items))


def _hit(item: object) -> ItemOutcome:
    """An arm that answers the item correctly (strict pass)."""
    return ItemOutcome(
        item_id=item.id,  # type: ignore[attr-defined]
        observed_behavior="answer",
        candidate_cites=(_path(),),
        retrieved_path_keys=("rta-2006|part:III|section:20|subsection:1",),
        latency_ms={"total": 1000.0},
        cost_usd=0.0,
        trace_id="a" * 32,
    )


def _miss(item: object) -> ItemOutcome:
    """An arm that gets the behavior right but cites nothing (strict fail)."""
    return ItemOutcome(
        item_id=item.id,  # type: ignore[attr-defined]
        observed_behavior="answer",
        candidate_cites=(),
        retrieved_path_keys=(),
        latency_ms={"total": 10.0},
        cost_usd=0.0,
        trace_id="b" * 32,
    )


def test_comparison_runs_the_same_items_through_both_arms() -> None:
    golden = _set(_answer_item("a1"), _answer_item("a2"))
    items = select_run_items(golden, include_holdout=True)

    naive_seen: list[str] = []
    agent_seen: list[str] = []

    def naive(item: object) -> ItemOutcome:
        naive_seen.append(item.id)  # type: ignore[attr-defined]
        return _miss(item)

    def agent(item: object) -> ItemOutcome:
        agent_seen.append(item.id)  # type: ignore[attr-defined]
        return _hit(item)

    result = run_comparison(
        items=items,
        documents=_DOCUMENTS,
        naive_answer=naive,
        agent_answer=agent,
        score_sink=lambda **_kw: None,
    )
    # Both arms saw the identical item set (paired).
    assert set(naive_seen) == set(agent_seen) == {"a1", "a2"}
    assert {r.slice for r in result.dashboard.slices} == {"answer"}


def test_agent_lift_shows_up_as_a_positive_strict_pass_delta() -> None:
    golden = _set(_answer_item("a1"), _answer_item("a2"))
    items = select_run_items(golden, include_holdout=True)
    result = run_comparison(
        items=items,
        documents=_DOCUMENTS,
        naive_answer=_miss,  # naive-rag fails strict (no cites)
        agent_answer=_hit,  # agent passes strict
        score_sink=lambda **_kw: None,
    )
    assert result.dashboard.overall.naive_strict_pass_rate == 0.0
    assert result.dashboard.overall.agent_strict_pass_rate == 1.0
    assert result.dashboard.overall.strict_pass_delta == 1.0


def test_comparison_writes_scores_for_both_arms_to_the_sink() -> None:
    golden = _set(_answer_item("a1"))
    items = select_run_items(golden, include_holdout=True)
    captured: list[tuple[str | None, str, float]] = []

    def sink(*, trace_id: str | None, name: str, value: float) -> None:
        captured.append((trace_id, name, value))

    run_comparison(
        items=items,
        documents=_DOCUMENTS,
        naive_answer=_miss,
        agent_answer=_hit,
        score_sink=sink,
    )
    # Both arms' service traces received a strict_pass score, correlated by id.
    trace_ids = {tid for tid, name, _ in captured if name == "strict_pass"}
    assert "a" * 32 in trace_ids  # agent (hit)
    assert "b" * 32 in trace_ids  # naive (miss)


def test_comparison_result_carries_the_measured_items() -> None:
    golden = _set(_answer_item("a1"), _answer_item("a2"))
    items = select_run_items(golden, include_holdout=True)
    result = run_comparison(
        items=items,
        documents=_DOCUMENTS,
        naive_answer=_hit,
        agent_answer=_hit,
        score_sink=lambda **_kw: None,
    )
    assert {i.id for i in result.items} == {"a1", "a2"}
