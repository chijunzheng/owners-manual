"""Judge-judge κ + calibration-table render tests (issue #19, ADR 0010 Decisions 3 & 6).

ADR 0010 Decision 6: run Gemini over the same answers and publish THREE numbers —
κ(Claude↔human) [the primary trust label], κ(Gemini↔human), κ(Claude↔Gemini). High
judge-judge κ with low agreement-to-human flags a shared same-family bias (the
failure ADR 0005's cross-family split exists to catch); Gemini is never averaged
into the headline. Decision 3 fixes the Landis–Koch trust bands the table prints.

These pin the pure math and the render — never LLM quality:

* the three κ are computed from three aligned per-point verdict streams;
* the trust band follows Landis–Koch (κ≥0.61 trusted; 0.41–0.60 with analysis; else not);
* the README table shows the three κ + the primary CI + the per-class headline.
"""

from __future__ import annotations

import pytest

from owners_manual_evals.calibration import PointAgreement, compute_calibration
from owners_manual_evals.calibration_report import (
    JudgeJudgeKappa,
    PointDecision,
    judge_judge_kappas,
    render_calibration_table,
    trust_band,
)


def _stream(credited: list[bool], *, behavior_class: str = "answer") -> tuple[PointDecision, ...]:
    return tuple(
        PointDecision(
            item_id=f"item-{i}",
            point_id=f"p{i}",
            behavior_class=behavior_class,
            credited=value,
        )
        for i, value in enumerate(credited)
    )


# --- the three κ -----------------------------------------------------------


def test_three_kappas_from_aligned_verdict_streams() -> None:
    human = _stream([True, True, False, False])
    claude = _stream([True, True, False, False])  # identical to human → κ = 1
    gemini = _stream([True, False, False, False])  # differs on one point

    result = judge_judge_kappas(human=human, claude=claude, gemini=gemini)
    assert isinstance(result, JudgeJudgeKappa)
    assert result.claude_vs_human == pytest.approx(1.0)
    assert result.gemini_vs_human == pytest.approx(0.5)
    assert result.claude_vs_gemini == pytest.approx(0.5)


def test_judge_judge_requires_the_streams_to_cover_the_same_points() -> None:
    human = _stream([True, False])
    claude = _stream([True, False])
    gemini = (PointDecision(item_id="x", point_id="other", behavior_class="answer", credited=True),)
    with pytest.raises(ValueError, match="same|align|cover"):
        judge_judge_kappas(human=human, claude=claude, gemini=gemini)


# --- the Landis–Koch trust band --------------------------------------------


def test_trust_band_follows_landis_koch_thresholds() -> None:
    assert trust_band(0.75) == "trusted"
    assert trust_band(0.61) == "trusted"  # the 0.61 boundary is trusted
    assert trust_band(0.50) == "published-with-analysis"
    assert trust_band(0.41) == "published-with-analysis"  # 0.41 boundary
    assert trust_band(0.40) == "not-trusted"
    assert trust_band(0.0) == "not-trusted"


# --- the README calibration table ------------------------------------------


def _primary() -> object:
    # answer points agree perfectly; one refusal point disagrees (a mixed κ).
    answer = tuple(
        PointAgreement(
            item_id=f"a{i}",
            point_id=f"p{i}",
            behavior_class="answer",
            human_credited=v,
            judge_credited=v,
        )
        for i, v in enumerate([True, True, False, False])
    )
    refuse = (
        PointAgreement(
            item_id="r0",
            point_id="rp0",
            behavior_class="refuse-out-of-scope",
            human_credited=True,
            judge_credited=False,
        ),
    )
    return compute_calibration((*answer, *refuse), seed=1, iterations=200)


def test_table_shows_the_three_kappas_the_ci_and_the_per_class_headline() -> None:
    primary = _primary()
    judge_judge = JudgeJudgeKappa(
        claude_vs_human=primary.kappa,  # type: ignore[attr-defined]
        gemini_vs_human=0.52,
        claude_vs_gemini=0.81,
    )
    table = render_calibration_table(primary=primary, judge_judge=judge_judge)

    # All three pairings are named.
    assert "Claude" in table and "human" in table
    assert "Gemini" in table
    # The two diagnostic κ render.
    assert "0.52" in table
    assert "0.81" in table
    # The primary CI bounds render (the seeded bootstrap interval).
    assert f"{primary.kappa_ci.low:.2f}" in table  # type: ignore[attr-defined]
    assert f"{primary.kappa_ci.high:.2f}" in table  # type: ignore[attr-defined]
    # The prevalence guard is visible beside κ (ADR Decision 3).
    assert "revalence" in table  # "prevalence"/"Prevalence"
    # The per-behavior-class headline is present.
    assert "answer" in table
    assert "refuse-out-of-scope" in table
    # The trust band is printed.
    assert trust_band(primary.kappa) in table  # type: ignore[attr-defined]


def test_table_marks_gemini_as_diagnostic_only() -> None:
    primary = _primary()
    judge_judge = JudgeJudgeKappa(
        claude_vs_human=primary.kappa,  # type: ignore[attr-defined]
        gemini_vs_human=0.52,
        claude_vs_gemini=0.81,
    )
    table = render_calibration_table(primary=primary, judge_judge=judge_judge)
    # Gemini is the same-family secondary — never averaged into the headline (Decision 6).
    assert "diagnostic" in table.lower()
