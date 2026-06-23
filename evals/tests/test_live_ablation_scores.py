"""Live ablation-score reader assembly tests (issue #23 AC3).

The live Langfuse reader is wired behind the same seam the table generator's tests
mock; what is unit-testable here (offline) is the PURE assembly: given a per-rung
strict-pass aggregate read off Langfuse (keyed by rung id) plus the per-stage
rescue aggregate, assemble the ``buildup`` / ``knockout`` / ``mechanism`` rows in
the canonical dependency order the README tables expect. The actual Langfuse
score-fetch is the ``pragma: no cover`` live binding (like :mod:`live_runner`).
"""

from __future__ import annotations

from owners_manual_evals.ablation_ladders import (
    ladder_run_plan,
    live_enforceable_components,
)
from owners_manual_evals.ablation_tables import (
    LadderRowFromLangfuse,
    MechanismRowFromLangfuse,
)
from owners_manual_evals.live_ablation_scores import (
    assemble_ladder_rows,
    mean_or_none,
)


def _strict_by_rung() -> dict[str, float]:
    plan = ladder_run_plan()
    enforceable = list(live_enforceable_components())
    # A monotone build-up and a uniform knock-out, keyed by the plan's rung ids.
    rates: dict[str, float] = {}
    for step in plan:
        if step.ladder == "build-up":
            if step.component_key is None:
                rung_index = 0
            else:
                rung_index = enforceable.index(step.component_key) + 1
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
    # Floor first (component_key None), then the live-enforceable components in
    # dependency order (the live plan emits no rung for an unsupported component).
    assert buildup[0].component_key is None
    assert tuple(row.component_key for row in buildup[1:]) == live_enforceable_components()


def test_assembles_knockout_rows_for_every_enforceable_component() -> None:
    data = assemble_ladder_rows(strict_pass_by_rung=_strict_by_rung(), rescue_by_stage={})
    knockout = data["knockout"]
    assert {row.component_key for row in knockout} == set(live_enforceable_components())


def _a_knockout_rung_id() -> str:
    plan = ladder_run_plan()
    return next(step.rung_id for step in plan if step.ladder == "knock-out")


def test_missing_rung_score_is_surfaced_not_silently_zeroed() -> None:
    # A rung Langfuse has no score for must raise — a derived table that silently
    # shows 0.00% for an unrun rung would be a lie about the run.
    missing = _a_knockout_rung_id()
    partial = _strict_by_rung()
    del partial[missing]
    try:
        assemble_ladder_rows(strict_pass_by_rung=partial, rescue_by_stage={})
    except ValueError as error:
        assert missing in str(error)
    else:  # pragma: no cover
        raise AssertionError("expected a ValueError for a missing rung score")


def test_mean_or_none_distinguishes_no_data_from_a_real_zero() -> None:
    # Codex Finding 2: the live reader must NOT collapse "no Langfuse data" into a
    # fabricated 0.0. The pure mean helper returns None for an empty read and the
    # actual mean otherwise (a genuine all-fail rung is a real 0.0, NOT None).
    assert mean_or_none([]) is None
    assert mean_or_none([0.0, 0.0]) == 0.0
    assert mean_or_none([1.0, 0.0]) == 0.5
    assert mean_or_none([0.5]) == 0.5


def test_reader_omits_a_rung_with_no_data_so_the_missing_rung_raises() -> None:
    # The empty-vs-data decision is PURE and tested here (Finding 2): a rung whose
    # Langfuse read is empty is OMITTED from strict_pass_by_rung — driving
    # assemble_ladder_rows' missing-rung raise — never published as a 0.00% row.
    from owners_manual_evals.live_ablation_scores import strict_pass_by_rung_from_means

    plan = ladder_run_plan()
    # Every rung has data EXCEPT one knock-out rung, whose Langfuse read is empty.
    empty_rung = _a_knockout_rung_id()
    means: dict[str, float | None] = {}
    for step in plan:
        means[step.rung_id] = None if step.rung_id == empty_rung else 0.5
    by_rung = strict_pass_by_rung_from_means(means)
    # The empty rung is omitted (not zero-filled), so the downstream raise fires.
    assert empty_rung not in by_rung
    try:
        assemble_ladder_rows(strict_pass_by_rung=by_rung, rescue_by_stage={})
    except ValueError as error:
        assert empty_rung in str(error)
    else:  # pragma: no cover
        raise AssertionError("expected a ValueError for the omitted (no-data) rung")


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
