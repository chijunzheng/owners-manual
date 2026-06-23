"""Redundancy-findings tests (issue #23 AC4) + the order-dependence caveat.

AC4 — "Redundancy findings surfaced (big on build-up, small on knock-out)."
CONTEXT.md ("Ablation ladder"): "A component big on build-up but small on knock-out
was absorbed by later additions — a redundancy finding."

So per component the finding compares its build-up ARRIVAL delta (value on
arrival) against its knock-out REMOVAL magnitude (value in place). A component that
added a lot on arrival but whose removal barely dents the final system was made
redundant by components added after it. The build-up ladder is order-dependent
(each arrival delta is conditional on what came before), so a caveat must be
printed beside it — never hidden (README: "the README says so rather than hiding
it").
"""

from __future__ import annotations

from owners_manual_evals.ablation_ladders import (
    COMPONENT_KEYS,
    LadderRung,
    LadderRunResult,
    redundancy_findings,
)
from owners_manual_evals.bootstrap import ConfidenceInterval


def _ci(point: float) -> ConfidenceInterval:
    half = 0.02
    return ConfidenceInterval(
        point_estimate=point,
        low=point - half,
        high=point + half,
        confidence=0.95,
        iterations=100,
    )


def _buildup_rung(key: str | None, point: float) -> LadderRung:
    from owners_manual_evals.ablation_ladders import flags_for_buildup_rung

    return LadderRung(
        ladder="build-up",
        component_key=key,
        flags=flags_for_buildup_rung(0),
        build="build-full",
        strict_pass_rate=0.5,
        delta=_ci(point),
    )


def _knockout_rung(key: str, point: float) -> LadderRung:
    from owners_manual_evals.ablation_ladders import flags_for_knockout_rung

    return LadderRung(
        ladder="knock-out",
        component_key=key,
        flags=flags_for_knockout_rung(key),
        build="build-full",
        strict_pass_rate=0.5,
        delta=_ci(point),
    )


def _result_with(
    *,
    buildup_deltas: dict[str, float],
    knockout_deltas: dict[str, float],
) -> LadderRunResult:
    buildup = (_buildup_rung(None, 0.0),) + tuple(
        _buildup_rung(key, buildup_deltas[key]) for key in COMPONENT_KEYS
    )
    knockout = tuple(_knockout_rung(key, knockout_deltas[key]) for key in COMPONENT_KEYS)
    return LadderRunResult(run_name="t", buildup=buildup, knockout=knockout)


def test_big_on_buildup_small_on_knockout_is_flagged_redundant() -> None:
    # hybrid-bm25: +0.30 on arrival, but removing it from the full system costs
    # only 0.02 → absorbed by later additions → a redundancy finding.
    result = _result_with(
        buildup_deltas={k: (0.30 if k == "hybrid-bm25" else 0.05) for k in COMPONENT_KEYS},
        knockout_deltas={k: (-0.02 if k == "hybrid-bm25" else -0.20) for k in COMPONENT_KEYS},
    )
    findings = redundancy_findings(result)
    redundant_keys = {f.component_key for f in findings if f.is_redundant}
    assert "hybrid-bm25" in redundant_keys


def test_load_bearing_component_is_not_flagged_redundant() -> None:
    # critic: small on arrival (+0.03) but its removal breaks the system (-0.30) —
    # load-bearing in place, NOT redundant.
    result = _result_with(
        buildup_deltas={k: (0.03 if k == "critic" else 0.10) for k in COMPONENT_KEYS},
        knockout_deltas={k: (-0.30 if k == "critic" else -0.10) for k in COMPONENT_KEYS},
    )
    findings = redundancy_findings(result)
    by_key = {f.component_key: f for f in findings}
    assert by_key["critic"].is_redundant is False


def test_every_component_gets_a_finding_with_both_deltas() -> None:
    result = _result_with(
        buildup_deltas=dict.fromkeys(COMPONENT_KEYS, 0.1),
        knockout_deltas=dict.fromkeys(COMPONENT_KEYS, -0.1),
    )
    findings = redundancy_findings(result)
    assert {f.component_key for f in findings} == set(COMPONENT_KEYS)
    for finding in findings:
        # Each finding carries both the arrival delta and the removal magnitude it
        # was judged from, so the verdict is auditable, not just a boolean.
        assert finding.buildup_delta == 0.1
        assert finding.knockout_magnitude == 0.1


def test_redundancy_render_prints_the_order_dependence_caveat() -> None:
    from owners_manual_evals.ablation_ladders import render_ladders

    result = _result_with(
        buildup_deltas={k: (0.30 if k == "hybrid-bm25" else 0.05) for k in COMPONENT_KEYS},
        knockout_deltas={k: (-0.02 if k == "hybrid-bm25" else -0.20) for k in COMPONENT_KEYS},
    )
    text = render_ladders(result)
    # The order-dependence caveat sits beside the build-up ladder, not hidden.
    assert "order-dependent" in text.lower() or "order dependence" in text.lower()
    # The redundancy finding is surfaced by name.
    assert "hybrid-bm25" in text
    assert "redundan" in text.lower()
