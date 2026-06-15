"""Paired agent-vs-naive-rag score-dashboard tests (issue #15 AC4).

The agent arm is scored on the dashboard BESIDE naive-rag, over the SAME golden
items, paired by item id. These pin: per-slice rows plus an ``all`` row over
items; each arm in its own columns with the strict-pass delta; the same two
CONTEXT.md rules the score dashboard obeys (no blended scalar; slices never
averaged); a refusal contributes equally to both arms; and an honest sign in the
headline (the agent is not assumed to win).
"""

from __future__ import annotations

from owners_manual_evals.arm_dashboard import build_arm_dashboard, render_arm_dashboard
from owners_manual_evals.metrics import ItemScore


def _score(item_id: str, behavior: str, *, strict: bool, recall: float = 1.0) -> ItemScore:
    return ItemScore(
        item_id=item_id,
        behavior_class=behavior,
        behavior_match=True,
        cite_precision=1.0,
        cite_recall=recall,
        retrieval_hit_rate=recall,
        strict_pass=strict,
    )


def _naive() -> list[ItemScore]:
    return [
        _score("a1", "answer", strict=False, recall=0.5),
        _score("a2", "answer", strict=False, recall=0.0),
        _score("v1", "flag-void-clause", strict=False, recall=0.5),
        _score("r1", "refuse-jurisdiction", strict=True),
    ]


def _agent() -> list[ItemScore]:
    # the agent passes strictly where naive-rag did not
    return [
        _score("a1", "answer", strict=True),
        _score("a2", "answer", strict=False, recall=0.5),
        _score("v1", "flag-void-clause", strict=True),
        _score("r1", "refuse-jurisdiction", strict=True),
    ]


def test_dashboard_has_per_slice_rows_and_an_all_row() -> None:
    dash = build_arm_dashboard(naive_rag=_naive(), agent=_agent())
    names = {row.slice for row in dash.slices}
    assert "answer" in names
    assert "flag-void-clause" in names
    assert "refuse-jurisdiction" in names
    assert dash.overall.slice == "all"


def test_each_row_reports_both_arms_and_the_strict_pass_delta() -> None:
    dash = build_arm_dashboard(naive_rag=_naive(), agent=_agent())
    answer = next(row for row in dash.slices if row.slice == "answer")
    # naive strict: (0 + 0)/2 = 0.0 ; agent strict: (1 + 0)/2 = 0.5
    assert answer.naive_strict_pass_rate == 0.0
    assert answer.agent_strict_pass_rate == 0.5
    assert answer.strict_pass_delta == 0.5


def test_all_row_is_over_items_not_a_mean_of_slice_means() -> None:
    dash = build_arm_dashboard(naive_rag=_naive(), agent=_agent())
    # naive all strict: (0+0+0+1)/4 = 0.25 ; agent all strict: (1+0+1+1)/4 = 0.75
    assert dash.overall.naive_strict_pass_rate == 0.25
    assert dash.overall.agent_strict_pass_rate == 0.75
    assert abs(dash.overall.strict_pass_delta - 0.5) < 1e-12


def test_pairs_by_item_id_regardless_of_input_order() -> None:
    dash = build_arm_dashboard(naive_rag=_naive(), agent=list(reversed(_agent())))
    answer = next(row for row in dash.slices if row.slice == "answer")
    assert answer.agent_strict_pass_rate == 0.5


def test_raises_when_arms_cover_different_items() -> None:
    try:
        build_arm_dashboard(
            naive_rag=[_score("a1", "answer", strict=False)],
            agent=[_score("a2", "answer", strict=True)],
        )
    except ValueError:
        return
    raise AssertionError("expected a ValueError when the two arms cover different items")


def test_refusal_contributes_equally_to_both_arms() -> None:
    dash = build_arm_dashboard(
        naive_rag=[_score("r1", "refuse-jurisdiction", strict=True)],
        agent=[_score("r1", "refuse-jurisdiction", strict=True)],
    )
    assert dash.overall.naive_strict_pass_rate == 1.0
    assert dash.overall.agent_strict_pass_rate == 1.0
    assert dash.overall.strict_pass_delta == 0.0


def test_render_names_both_arms_shows_delta_no_blended_scalar() -> None:
    dash = build_arm_dashboard(naive_rag=_naive(), agent=_agent())
    text = render_arm_dashboard(dash, run_name="golden-v0")
    assert "golden-v0" in text
    assert "naive" in text.lower()
    assert "agent" in text.lower()
    assert "delta" in text.lower() or "Δ" in text
    assert "blended" not in text.lower()
    assert "composite" not in text.lower()


def test_render_states_which_way_it_went() -> None:
    up = build_arm_dashboard(naive_rag=_naive(), agent=_agent())
    assert "agent ahead" in render_arm_dashboard(up, run_name="x")
    # When the agent is worse, the headline reports it honestly.
    down = build_arm_dashboard(naive_rag=_agent(), agent=_naive())
    assert "naive-rag ahead" in render_arm_dashboard(down, run_name="x")
