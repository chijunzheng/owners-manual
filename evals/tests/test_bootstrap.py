"""Paired-by-item bootstrap confidence-interval tests (issue #20 AC1).

CONTEXT.md ("Variance audit"): "arm gaps are paired-by-item with bootstrap CIs
over items". This pins the resampling that puts a CI on every published gap:

* the resample is PAIRED — the same resampled item indices score both arms, so a
  gap CI reflects per-item correlation, never two independently shuffled samples;
* it is SEEDED — the same seed yields the same interval, so the suite is
  reproducible and no unseeded RNG ever reaches the shipped path;
* a degenerate input (every per-item gap identical) yields a zero-width interval
  whose endpoints equal the point estimate — the CI cannot claim spread that the
  data does not contain.
"""

from __future__ import annotations

from owners_manual_evals.bootstrap import bootstrap_paired_gap_ci
from owners_manual_evals.metrics import ItemScore


def _score(item_id: str, *, strict: bool) -> ItemScore:
    return ItemScore(
        item_id=item_id,
        behavior_class="answer",
        behavior_match=True,
        cite_precision=1.0,
        cite_recall=1.0 if strict else 0.0,
        retrieval_hit_rate=1.0,
        strict_pass=strict,
    )


def _strict_rate(scores: tuple[ItemScore, ...]) -> float:
    return sum(1.0 if s.strict_pass else 0.0 for s in scores) / len(scores)


def test_point_estimate_is_the_observed_paired_gap() -> None:
    # baseline passes 1/4, treatment passes 3/4 → observed gap +0.5.
    baseline = (
        _score("i1", strict=True),
        _score("i2", strict=False),
        _score("i3", strict=False),
        _score("i4", strict=False),
    )
    treatment = (
        _score("i1", strict=True),
        _score("i2", strict=True),
        _score("i3", strict=True),
        _score("i4", strict=False),
    )
    ci = bootstrap_paired_gap_ci(
        baseline=baseline,
        treatment=treatment,
        statistic=_strict_rate,
        iterations=500,
        seed=1234,
    )
    assert ci.point_estimate == 0.5


def test_resampling_is_seeded_and_reproducible() -> None:
    baseline = tuple(_score(f"i{i}", strict=i % 2 == 0) for i in range(20))
    treatment = tuple(_score(f"i{i}", strict=i % 3 == 0) for i in range(20))
    a = bootstrap_paired_gap_ci(
        baseline=baseline, treatment=treatment, statistic=_strict_rate, iterations=400, seed=7
    )
    b = bootstrap_paired_gap_ci(
        baseline=baseline, treatment=treatment, statistic=_strict_rate, iterations=400, seed=7
    )
    # Same seed → byte-identical interval (no unseeded RNG on the shipped path).
    assert (a.low, a.point_estimate, a.high) == (b.low, b.point_estimate, b.high)


def test_different_seeds_can_differ_but_bracket_the_point_estimate() -> None:
    baseline = tuple(_score(f"i{i}", strict=i % 2 == 0) for i in range(20))
    treatment = tuple(_score(f"i{i}", strict=i % 3 == 0) for i in range(20))
    a = bootstrap_paired_gap_ci(
        baseline=baseline, treatment=treatment, statistic=_strict_rate, iterations=400, seed=1
    )
    b = bootstrap_paired_gap_ci(
        baseline=baseline, treatment=treatment, statistic=_strict_rate, iterations=400, seed=2
    )
    # The point estimate is data, not RNG — identical across seeds.
    assert a.point_estimate == b.point_estimate
    # The interval contains the point estimate on both runs.
    assert a.low <= a.point_estimate <= a.high
    assert b.low <= b.point_estimate <= b.high


def test_identical_per_item_gap_gives_a_zero_width_interval() -> None:
    # Every item: baseline fails, treatment passes → per-item gap is +1 everywhere,
    # so every resample reproduces +1.0 and the interval has zero width.
    baseline = tuple(_score(f"i{i}", strict=False) for i in range(8))
    treatment = tuple(_score(f"i{i}", strict=True) for i in range(8))
    ci = bootstrap_paired_gap_ci(
        baseline=baseline, treatment=treatment, statistic=_strict_rate, iterations=300, seed=99
    )
    assert ci.point_estimate == 1.0
    assert ci.low == 1.0
    assert ci.high == 1.0


def test_interval_is_ordered_low_le_high() -> None:
    baseline = tuple(_score(f"i{i}", strict=i % 4 == 0) for i in range(16))
    treatment = tuple(_score(f"i{i}", strict=i % 2 == 0) for i in range(16))
    ci = bootstrap_paired_gap_ci(
        baseline=baseline, treatment=treatment, statistic=_strict_rate, iterations=500, seed=3
    )
    assert ci.low <= ci.high


def test_rejects_mismatched_item_sets() -> None:
    baseline = (_score("i1", strict=True), _score("i2", strict=False))
    treatment = (_score("i1", strict=True), _score("x9", strict=True))
    try:
        bootstrap_paired_gap_ci(
            baseline=baseline,
            treatment=treatment,
            statistic=_strict_rate,
            iterations=10,
            seed=1,
        )
    except ValueError as error:
        assert "paired" in str(error).lower() or "same item" in str(error).lower()
    else:  # pragma: no cover
        raise AssertionError("expected a ValueError for mismatched item sets")


def test_excludes_the_point_estimate_band_can_be_set() -> None:
    # A 90% interval is narrower than a 99% interval over the same resamples.
    baseline = tuple(_score(f"i{i}", strict=i % 2 == 0) for i in range(30))
    treatment = tuple(_score(f"i{i}", strict=i % 5 == 0) for i in range(30))
    narrow = bootstrap_paired_gap_ci(
        baseline=baseline,
        treatment=treatment,
        statistic=_strict_rate,
        iterations=600,
        seed=11,
        confidence=0.90,
    )
    wide = bootstrap_paired_gap_ci(
        baseline=baseline,
        treatment=treatment,
        statistic=_strict_rate,
        iterations=600,
        seed=11,
        confidence=0.99,
    )
    assert (wide.high - wide.low) >= (narrow.high - narrow.low)
