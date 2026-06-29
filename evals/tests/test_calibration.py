"""Cohen's-κ calibration-core tests (issue #19, ADR 0010 Decisions 1 & 3).

ADR 0010 Decision 1 fixes the unit of agreement as the per-answer-point binary
(human ``human_point:<id>`` ↔ judge ``judge_point:<id>``); Decision 3 fixes the
REPORTING: observed agreement, positive/negative prevalence, Cohen's κ, and κ's
seeded-bootstrap CI — per behavior class and pooled. The prevalence is load-bearing
(the "κ collapses under prevalence" force): a judge crediting 95% of points posts
~95% raw agreement and a near-zero κ, so κ is never published alone.

These pin the math and the result shape — never LLM quality:

* κ = 1.0 on perfect (mixed) agreement; κ ≈ 0 on independent/chance agreement;
* a hand-computed 2×2 table yields the textbook κ;
* the result carries agreement + prevalence + a CI + per-class κ, not κ alone;
* the bootstrap CI is deterministic under a fixed seed (no unseeded RNG ships).
"""

from __future__ import annotations

import pytest

from owners_manual_evals.bootstrap import ConfidenceInterval
from owners_manual_evals.calibration import (
    PointAgreement,
    bootstrap_kappa_ci,
    cohen_kappa,
    compute_calibration,
    observed_agreement,
    positive_prevalence,
    require_verdict,
)


def _pairs(*, n11: int, n10: int, n01: int, n00: int) -> list[tuple[bool, bool]]:
    """A 2×2 (human, judge) confusion expanded to individual decisions.

    ``n11`` both credit, ``n10`` human credits/judge not, ``n01`` human not/judge
    credits, ``n00`` both not.
    """
    return (
        [(True, True)] * n11
        + [(True, False)] * n10
        + [(False, True)] * n01
        + [(False, False)] * n00
    )


def _agreements(
    pairs: list[tuple[bool, bool]],
    *,
    behavior_class: str = "answer",
    item_id: str = "item",
) -> tuple[PointAgreement, ...]:
    return tuple(
        PointAgreement(
            item_id=f"{item_id}-{i}",
            point_id=f"p{i}",
            behavior_class=behavior_class,
            human_credited=human,
            judge_credited=judge,
        )
        for i, (human, judge) in enumerate(pairs)
    )


# --- the κ math ------------------------------------------------------------


def test_kappa_is_one_on_perfect_agreement() -> None:
    # 6 both-credit + 4 both-not: zero off-diagonal, mixed base rate so chance < 1.
    pairs = _pairs(n11=6, n10=0, n01=0, n00=4)
    assert cohen_kappa(pairs) == pytest.approx(1.0)


def test_kappa_is_about_zero_on_chance_agreement() -> None:
    # Two independent 50/50 raters: p_o == p_e == 0.5, so κ is exactly 0.
    pairs = _pairs(n11=25, n10=25, n01=25, n00=25)
    assert cohen_kappa(pairs) == pytest.approx(0.0, abs=1e-9)


def test_hand_computed_two_by_two_yields_the_textbook_kappa() -> None:
    # n=50: p_o = (20+15)/50 = 0.70; marginals human+ = 0.50, judge+ = 0.60;
    # p_e = .5*.6 + .5*.4 = 0.50; κ = (0.70-0.50)/(1-0.50) = 0.40.
    pairs = _pairs(n11=20, n10=5, n01=10, n00=15)
    assert cohen_kappa(pairs) == pytest.approx(0.40)
    assert observed_agreement(pairs) == pytest.approx(0.70)


def test_positive_and_negative_prevalence_pool_both_raters_and_sum_to_one() -> None:
    # human credits 25/50, judge credits 30/50 → 55 credited of 100 decisions.
    pairs = _pairs(n11=20, n10=5, n01=10, n00=15)
    assert positive_prevalence(pairs) == pytest.approx(0.55)
    pos = positive_prevalence(pairs)
    result = compute_calibration(_agreements(pairs), seed=1, iterations=200)
    assert result.positive_prevalence == pytest.approx(pos)
    assert result.positive_prevalence + result.negative_prevalence == pytest.approx(1.0)


def test_empty_input_raises_rather_than_dividing_by_zero() -> None:
    with pytest.raises(ValueError, match="at least one"):
        cohen_kappa([])


# --- the result object exposes more than κ (the prevalence guard) ----------


def test_result_carries_agreement_prevalence_and_ci_not_just_kappa() -> None:
    pairs = _pairs(n11=20, n10=5, n01=10, n00=15)
    result = compute_calibration(_agreements(pairs), seed=7, iterations=300)
    # κ never travels alone (ADR Decision 3): every companion is populated.
    assert result.kappa == pytest.approx(0.40)
    assert result.observed_agreement == pytest.approx(0.70)
    assert result.positive_prevalence == pytest.approx(0.55)
    assert result.negative_prevalence == pytest.approx(0.45)
    assert isinstance(result.kappa_ci, ConfidenceInterval)
    assert result.kappa_ci.point_estimate == pytest.approx(0.40)
    assert result.n_decisions == 50


def test_per_class_kappa_is_stratified_by_behavior_class() -> None:
    # answer points agree perfectly (κ=1); refusal points are pure chance (κ=0).
    answer = _agreements(_pairs(n11=6, n10=0, n01=0, n00=4), behavior_class="answer", item_id="a")
    refuse = _agreements(
        _pairs(n11=25, n10=25, n01=25, n00=25),
        behavior_class="refuse-out-of-scope",
        item_id="r",
    )
    result = compute_calibration((*answer, *refuse), seed=1, iterations=200)
    assert result.per_class_kappa["answer"] == pytest.approx(1.0)
    assert result.per_class_kappa["refuse-out-of-scope"] == pytest.approx(0.0, abs=1e-9)


# --- the seeded bootstrap CI -----------------------------------------------


def test_bootstrap_kappa_ci_is_deterministic_under_a_fixed_seed() -> None:
    pairs = _pairs(n11=20, n10=5, n01=10, n00=15)
    a = bootstrap_kappa_ci(pairs, seed=42, iterations=500)
    b = bootstrap_kappa_ci(pairs, seed=42, iterations=500)
    assert (a.low, a.point_estimate, a.high) == (b.low, b.point_estimate, b.high)


def test_bootstrap_kappa_point_estimate_is_the_observed_kappa_not_rng() -> None:
    pairs = _pairs(n11=20, n10=5, n01=10, n00=15)
    ci = bootstrap_kappa_ci(pairs, seed=1, iterations=400)
    # The point estimate is data, not RNG — it equals the observed κ on the full set.
    assert ci.point_estimate == pytest.approx(cohen_kappa(pairs))
    assert ci.low <= ci.point_estimate <= ci.high


def test_bootstrap_ci_narrows_or_holds_as_confidence_drops() -> None:
    pairs = _pairs(n11=18, n10=7, n01=9, n00=16)
    narrow = bootstrap_kappa_ci(pairs, seed=5, iterations=600, confidence=0.90)
    wide = bootstrap_kappa_ci(pairs, seed=5, iterations=600, confidence=0.99)
    assert (wide.high - wide.low) >= (narrow.high - narrow.low)


def test_degenerate_single_category_does_not_crash() -> None:
    # Both raters always credit: p_e == 1, so κ is undefined; the documented
    # convention returns 1.0 for perfect agreement rather than dividing by zero.
    pairs = _pairs(n11=10, n10=0, n01=0, n00=0)
    assert cohen_kappa(pairs) == pytest.approx(1.0)


# --- require_verdict: external judge JSON must be a real boolean (Codex P2) ----
# A non-bool external verdict that bool() would coerce silently flips a negative
# verdict to credited and inflates κ/prevalence — the CLI must fail loud instead.


def test_require_verdict_returns_a_real_boolean() -> None:
    verdicts = {"item-1": {"p1": True, "p2": False}}
    assert require_verdict(verdicts, item_id="item-1", point_id="p1") is True
    assert require_verdict(verdicts, item_id="item-1", point_id="p2") is False


def test_require_verdict_rejects_the_string_false() -> None:
    # bool("false") is True — the exact silent-inflation footgun. Reject it loud.
    with pytest.raises(ValueError, match="JSON boolean"):
        require_verdict({"i": {"p": "false"}}, item_id="i", point_id="p")


def test_require_verdict_rejects_an_int_zero_or_one() -> None:
    # 0/1 are not JSON booleans; a credit signal must be a true/false, not a number.
    with pytest.raises(ValueError, match="JSON boolean"):
        require_verdict({"i": {"p": 1}}, item_id="i", point_id="p")
    with pytest.raises(ValueError, match="JSON boolean"):
        require_verdict({"i": {"p": 0}}, item_id="i", point_id="p")


def test_require_verdict_fails_loud_on_a_missing_point() -> None:
    with pytest.raises(ValueError, match="missing"):
        require_verdict({"i": {"p": True}}, item_id="i", point_id="absent")
    with pytest.raises(ValueError, match="missing"):
        require_verdict({}, item_id="absent", point_id="p")
