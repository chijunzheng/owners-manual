"""Harness-runner tests (issue #10 AC1/AC2/AC4).

Pins the run orchestration without a live service or server: a fake answer
function stands in for the HTTP+Langfuse path, and a fake scorer sink captures
the scores the harness would write to Langfuse. The runner selects the dev
split by default (holdout sealed unless ``include_holdout``), pairs each item
by id, scores deterministically, and surfaces the dashboard plus the run record.
"""

from __future__ import annotations

from owners_manual_evals.citable_path import CitablePath, CitablePathSegment
from owners_manual_evals.document_tree import parse_document_tree
from owners_manual_evals.golden_item import parse_golden_item
from owners_manual_evals.golden_loader import GoldenSet
from owners_manual_evals.run_naive_rag import ItemOutcome, run_items, select_run_items

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


def _answer_item(item_id: str, *, verified: bool = True) -> object:
    return parse_golden_item(
        {
            "id": item_id,
            "behavior_class": "answer",
            "verified": verified,
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


def _refuse_item(item_id: str) -> object:
    return parse_golden_item(
        {
            "id": item_id,
            "behavior_class": "refuse-jurisdiction",
            "verified": True,
            "question": f"Q {item_id}",
            "answer_points": [{"id": "p1", "text": "t"}],
            "required_cites": [],
            "provenance": {"source": "behavior-design", "reference": "x"},
        },
        documents=_DOCUMENTS,
    )


def _set(*items: object) -> GoldenSet:
    return GoldenSet(version=1, items=tuple(items))


# --- selection -------------------------------------------------------------


def test_select_excludes_unverified_items() -> None:
    golden = _set(_answer_item("a"), _answer_item("b", verified=False))
    selected = select_run_items(golden, include_holdout=True)
    assert {i.id for i in selected} == {"a"}


def test_select_dev_only_by_default_seals_the_holdout() -> None:
    # Enough parents that the stratified split puts some on each side.
    items = [_answer_item(f"a{i}") for i in range(10)] + [_refuse_item(f"r{i}") for i in range(10)]
    golden = _set(*items)
    dev = select_run_items(golden, include_holdout=False)
    full = select_run_items(golden, include_holdout=True)
    assert len(dev) < len(full)
    assert {i.id for i in dev}.issubset({i.id for i in full})


def test_select_include_holdout_runs_every_verified_item() -> None:
    items = [_answer_item(f"a{i}") for i in range(10)] + [_refuse_item(f"r{i}") for i in range(10)]
    golden = _set(*items)
    full = select_run_items(golden, include_holdout=True)
    assert len(full) == 20


# --- run -------------------------------------------------------------------


def _good_answer(item: object) -> ItemOutcome:
    """A fake service answer that gets the answer item exactly right."""
    return ItemOutcome(
        item_id=item.id,  # type: ignore[attr-defined]
        observed_behavior="answer",
        candidate_cites=(_path(),),
        retrieved_path_keys=("rta-2006|part:III|section:20|subsection:1",),
        latency_ms={"total": 1000.0, "retrieval": 100.0, "synthesis": 900.0},
        cost_usd=0.01,
        trace_id="a" * 32,
    )


def test_run_scores_each_item_and_builds_a_dashboard() -> None:
    golden = _set(_answer_item("a1"), _answer_item("a2"))
    captured_scores: list[tuple[str, str, float]] = []

    def sink(*, trace_id: str | None, name: str, value: float) -> None:
        captured_scores.append((trace_id or "", name, value))

    result = run_items(
        items=select_run_items(golden, include_holdout=True),
        documents=_DOCUMENTS,
        answer=_good_answer,
        score_sink=sink,
    )
    assert result.dashboard.overall.strict_pass_rate == 1.0
    assert result.dashboard.overall.count == 2
    # A strict_pass score was written per item, propagated by trace id.
    names = {name for _tid, name, _v in captured_scores}
    assert "strict_pass" in names
    assert any(tid == "a" * 32 for tid, _n, _v in captured_scores)


def test_run_pairs_by_item_id_via_the_answer_function() -> None:
    golden = _set(_answer_item("only"))
    seen: list[str] = []

    def answer(item: object) -> ItemOutcome:
        seen.append(item.id)  # type: ignore[attr-defined]
        return _good_answer(item)

    run_items(
        items=select_run_items(golden, include_holdout=True),
        documents=_DOCUMENTS,
        answer=answer,
        score_sink=lambda **_kw: None,
    )
    assert seen == ["only"]


def test_run_records_a_wrong_behavior_as_a_strict_fail() -> None:
    golden = _set(_answer_item("a1"))

    def wrong(item: object) -> ItemOutcome:
        return ItemOutcome(
            item_id=item.id,  # type: ignore[attr-defined]
            observed_behavior="refuse-out-of-scope",
            candidate_cites=(),
            retrieved_path_keys=(),
            latency_ms={"total": 10.0, "retrieval": 1.0, "synthesis": 9.0},
            cost_usd=0.0,
            trace_id=None,
        )

    result = run_items(
        items=select_run_items(golden, include_holdout=True),
        documents=_DOCUMENTS,
        answer=wrong,
        score_sink=lambda **_kw: None,
    )
    assert result.dashboard.overall.strict_pass_rate == 0.0
