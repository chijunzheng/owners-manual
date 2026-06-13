"""Hybrid-vs-vector-only comparison tests (#14 AC4).

The comparison is the dashboard surface that reports the pre-synthesis required-
cite hit-rate for two arms side by side, per slice and overall, with the delta —
"whichever way it goes" (the issue). It is paired by item id (same items, two
arms), never averages slices together, and reports each arm in its own column
(no blended scalar) — the same CONTEXT.md rules the score dashboard obeys.

Pinned contract:
  * per-arm mean hit-rate per behavior-class slice plus an ``all`` row over items;
  * the delta column is hybrid minus vector-only (sign reported honestly);
  * a refusal item (no required cites) has hit-rate 1.0 in both arms and never
    drags the comparison;
  * the render names both arms, shows the delta, and contains no "overall score".
"""

from __future__ import annotations

from owners_manual_evals.arm_comparison import build_hit_rate_comparison, render_hit_rate_comparison
from owners_manual_evals.metrics import ItemScore


def _score(item_id: str, behavior: str, hit: float) -> ItemScore:
    return ItemScore(
        item_id=item_id,
        behavior_class=behavior,
        behavior_match=True,
        cite_precision=1.0,
        cite_recall=hit,
        retrieval_hit_rate=hit,
        strict_pass=hit == 1.0,
    )


def _vector() -> list[ItemScore]:
    return [
        _score("a1", "answer", 0.5),
        _score("a2", "answer", 0.0),
        _score("v1", "flag-void-clause", 0.5),
        _score("r1", "refuse-jurisdiction", 1.0),
    ]


def _hybrid() -> list[ItemScore]:
    # hybrid rescues some required cites the vector-only arm missed
    return [
        _score("a1", "answer", 1.0),
        _score("a2", "answer", 0.5),
        _score("v1", "flag-void-clause", 1.0),
        _score("r1", "refuse-jurisdiction", 1.0),
    ]


def test_comparison_has_per_slice_rows_and_an_all_row() -> None:
    comp = build_hit_rate_comparison(vector_only=_vector(), hybrid=_hybrid())
    names = {row.slice for row in comp.slices}
    assert "answer" in names
    assert "flag-void-clause" in names
    assert comp.overall.slice == "all"


def test_each_row_reports_both_arms_and_the_delta() -> None:
    comp = build_hit_rate_comparison(vector_only=_vector(), hybrid=_hybrid())
    answer = next(row for row in comp.slices if row.slice == "answer")
    # vector: (0.5 + 0.0)/2 = 0.25 ; hybrid: (1.0 + 0.5)/2 = 0.75
    assert answer.vector_only_hit_rate == 0.25
    assert answer.hybrid_hit_rate == 0.75
    assert answer.delta == 0.5


def test_all_row_is_over_items_not_a_mean_of_slice_means() -> None:
    comp = build_hit_rate_comparison(vector_only=_vector(), hybrid=_hybrid())
    # vector all: (0.5 + 0.0 + 0.5 + 1.0)/4 = 0.5 ; hybrid all: (1+0.5+1+1)/4 = 0.875
    assert comp.overall.vector_only_hit_rate == 0.5
    assert comp.overall.hybrid_hit_rate == 0.875
    assert abs(comp.overall.delta - 0.375) < 1e-12


def test_pairs_by_item_id_regardless_of_input_order() -> None:
    comp = build_hit_rate_comparison(
        vector_only=_vector(),
        hybrid=list(reversed(_hybrid())),
    )
    answer = next(row for row in comp.slices if row.slice == "answer")
    assert answer.hybrid_hit_rate == 0.75


def test_raises_when_arms_cover_different_items() -> None:
    try:
        build_hit_rate_comparison(
            vector_only=[_score("a1", "answer", 0.5)],
            hybrid=[_score("a2", "answer", 1.0)],
        )
    except ValueError:
        return
    raise AssertionError("expected a ValueError when the two arms cover different items")


def test_refusal_does_not_drag_the_comparison() -> None:
    comp = build_hit_rate_comparison(
        vector_only=[_score("r1", "refuse-jurisdiction", 1.0)],
        hybrid=[_score("r1", "refuse-jurisdiction", 1.0)],
    )
    assert comp.overall.vector_only_hit_rate == 1.0
    assert comp.overall.hybrid_hit_rate == 1.0
    assert comp.overall.delta == 0.0


def test_render_names_both_arms_shows_delta_no_blended_scalar() -> None:
    comp = build_hit_rate_comparison(vector_only=_vector(), hybrid=_hybrid())
    text = render_hit_rate_comparison(comp, run_name="golden-v0 fixtures")
    assert "golden-v0 fixtures" in text
    assert "vector" in text.lower()
    assert "hybrid" in text.lower()
    assert "delta" in text.lower() or "Δ" in text
    assert "blended" not in text.lower()
    assert "composite" not in text.lower()


def test_render_states_which_way_it_went() -> None:
    # The headline must report the sign honestly, not assume hybrid wins.
    comp_up = build_hit_rate_comparison(vector_only=_vector(), hybrid=_hybrid())
    assert "+" in render_hit_rate_comparison(comp_up, run_name="x")
    # When hybrid is worse, the headline shows a negative overall delta.
    comp_down = build_hit_rate_comparison(vector_only=_hybrid(), hybrid=_vector())
    assert "-" in render_hit_rate_comparison(comp_down, run_name="x")
