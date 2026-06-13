"""Score-dashboard tests (issue #10 AC1).

Pins the published shape (CONTEXT.md, "Score dashboard"): strict pass rate is
the headline; citation precision/recall and cost/latency are reported; metrics
are never collapsed into one blended scalar, and slices are never averaged
together. The dashboard slices by behavior class and reports an explicit "all"
row computed over items (not over slice means).
"""

from __future__ import annotations

from owners_manual_evals.dashboard import build_dashboard, render_dashboard
from owners_manual_evals.metrics import ItemScore


def _score(
    item_id: str,
    behavior_class: str,
    *,
    strict: bool,
    precision: float = 1.0,
    recall: float = 1.0,
    hit: float = 1.0,
    match: bool = True,
) -> ItemScore:
    return ItemScore(
        item_id=item_id,
        behavior_class=behavior_class,
        behavior_match=match,
        cite_precision=precision,
        cite_recall=recall,
        retrieval_hit_rate=hit,
        strict_pass=strict,
    )


def _latencies() -> dict[str, float]:
    return {"total": 1200.0, "retrieval": 200.0, "synthesis": 1000.0}


def _sample_scores() -> list[ItemScore]:
    return [
        _score("a1", "answer", strict=True),
        _score("a2", "answer", strict=False, recall=0.5, precision=0.5),
        _score("r1", "refuse-jurisdiction", strict=True),
    ]


def test_dashboard_has_a_per_behavior_class_slice_and_an_all_row() -> None:
    dash = build_dashboard(
        scores=_sample_scores(),
        latencies_ms=[_latencies(), _latencies(), _latencies()],
        cost_usd=[0.01, 0.01, 0.01],
    )
    slice_names = {s.name for s in dash.slices}
    assert "answer" in slice_names
    assert "refuse-jurisdiction" in slice_names
    assert dash.overall.name == "all"


def test_strict_pass_rate_is_the_headline_per_slice() -> None:
    dash = build_dashboard(
        scores=_sample_scores(),
        latencies_ms=[_latencies()] * 3,
        cost_usd=[0.0] * 3,
    )
    answer_slice = next(s for s in dash.slices if s.name == "answer")
    # 1 of 2 answer items passed strictly.
    assert answer_slice.strict_pass_rate == 0.5
    assert dash.overall.strict_pass_rate == 2 / 3


def test_all_row_is_over_items_not_a_mean_of_slice_means() -> None:
    # Two slices of unequal size: averaging slice means (0.5 and 1.0 -> 0.75)
    # would be wrong; the all row is 2/3 over items.
    dash = build_dashboard(
        scores=_sample_scores(),
        latencies_ms=[_latencies()] * 3,
        cost_usd=[0.0] * 3,
    )
    assert dash.overall.strict_pass_rate == 2 / 3


def test_dashboard_reports_cite_precision_recall_and_cost_latency() -> None:
    dash = build_dashboard(
        scores=_sample_scores(),
        latencies_ms=[_latencies()] * 3,
        cost_usd=[0.02, 0.02, 0.02],
    )
    answer_slice = next(s for s in dash.slices if s.name == "answer")
    assert answer_slice.mean_cite_precision == 0.75  # (1.0 + 0.5) / 2
    assert answer_slice.mean_cite_recall == 0.75
    assert dash.overall.total_cost_usd == 0.06
    assert dash.overall.p50_latency_ms == 1200.0


def test_render_dashboard_is_a_table_with_a_headline_and_no_blended_scalar() -> None:
    dash = build_dashboard(
        scores=_sample_scores(),
        latencies_ms=[_latencies()] * 3,
        cost_usd=[0.0] * 3,
    )
    text = render_dashboard(dash, run_name="naive-rag dev")
    assert "naive-rag dev" in text
    assert "strict" in text.lower()
    assert "answer" in text
    assert "all" in text
    # No single blended "overall score" number that collapses the metrics.
    assert "blended" not in text.lower()
    assert "composite" not in text.lower()


def test_empty_run_renders_without_crashing() -> None:
    dash = build_dashboard(scores=[], latencies_ms=[], cost_usd=[])
    assert dash.overall.count == 0
    text = render_dashboard(dash, run_name="empty")
    assert "empty" in text
