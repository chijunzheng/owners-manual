"""Live ablation-score reader assembly tests (issue #23 AC3).

The live Langfuse reader is wired behind the same seam the table generator's tests
mock; what is unit-testable here (offline) is the PURE assembly: given a per-rung
strict-pass aggregate read off Langfuse (keyed by rung id) plus the per-stage
rescue aggregate, assemble the ``buildup`` / ``knockout`` / ``mechanism`` rows in
the canonical dependency order the README tables expect. The actual Langfuse
score-fetch is the ``pragma: no cover`` live binding (like :mod:`live_runner`).
"""

from __future__ import annotations

from owners_manual_evals.ablation_ladders import COMPONENT_KEYS, ladder_run_plan
from owners_manual_evals.ablation_tables import (
    LadderRowFromLangfuse,
    MechanismRowFromLangfuse,
)
from owners_manual_evals.live_ablation_scores import assemble_ladder_rows


def _strict_by_rung() -> dict[str, float]:
    plan = ladder_run_plan()
    # A monotone build-up and a uniform knock-out, keyed by the plan's rung ids.
    rates: dict[str, float] = {}
    for step in plan:
        if step.ladder == "build-up":
            if step.component_key is None:
                rung_index = 0
            else:
                rung_index = COMPONENT_KEYS.index(step.component_key) + 1
            rates[step.rung_id] = 0.20 + 0.05 * rung_index
        else:
            rates[step.rung_id] = 0.58
    return rates


def test_assembles_buildup_rows_in_dependency_order() -> None:
    data = assemble_ladder_rows(
        strict_pass_by_rung=_strict_by_rung(),
        rescue_by_stage={},
    )
    buildup = data["buildup"]
    assert all(isinstance(row, LadderRowFromLangfuse) for row in buildup)
    # Floor first (component_key None), then the eight in dependency order.
    assert buildup[0].component_key is None
    assert tuple(row.component_key for row in buildup[1:]) == COMPONENT_KEYS


def test_assembles_knockout_rows_for_every_component() -> None:
    data = assemble_ladder_rows(strict_pass_by_rung=_strict_by_rung(), rescue_by_stage={})
    knockout = data["knockout"]
    assert {row.component_key for row in knockout} == set(COMPONENT_KEYS)


def test_missing_rung_score_is_surfaced_not_silently_zeroed() -> None:
    # A rung Langfuse has no score for must raise — a derived table that silently
    # shows 0.00% for an unrun rung would be a lie about the run.
    partial = _strict_by_rung()
    del partial["buildup-03-hybrid-bm25"]
    try:
        assemble_ladder_rows(strict_pass_by_rung=partial, rescue_by_stage={})
    except ValueError as error:
        assert "buildup-03-hybrid-bm25" in str(error)
    else:  # pragma: no cover
        raise AssertionError("expected a ValueError for a missing rung score")


def test_mechanism_rows_carry_reached_and_rescued_only() -> None:
    data = assemble_ladder_rows(
        strict_pass_by_rung=_strict_by_rung(),
        rescue_by_stage={
            "graph-expansion": (12, 4),
            "rerank-survivor": (20, 1),
        },
    )
    mechanism = {row.stage: row for row in data["mechanism"]}
    assert isinstance(mechanism["graph-expansion"], MechanismRowFromLangfuse)
    assert mechanism["graph-expansion"].reached == 12
    assert mechanism["graph-expansion"].rescued_only == 4
