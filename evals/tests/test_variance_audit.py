"""Variance-audit / noise-floor tests (issue #20 AC2, AC3).

CONTEXT.md ("Variance audit"): "A ~15-item slice run x5 per release to publish
the per-arm run-to-run noise floor. All other runs are n=1 per item; ... any gap
inside the noise floor is labeled 'within noise'. Exists because current models
expose no temperature control — variance is measured, not suppressed."

These pin:

* the slice is SEEDED so the same release samples the same ~15 items (no unseeded
  RNG selecting the audit slice);
* each arm is run REPEATS times and the per-arm noise floor is the spread of that
  arm's headline metric across the repeats — a constant arm has a zero floor;
* a gap is labeled within-noise when its magnitude does not exceed the combined
  per-arm noise floor of the two arms it spans.
"""

from __future__ import annotations

from owners_manual_evals.metrics import ItemScore
from owners_manual_evals.variance_audit import (
    NoiseFloor,
    is_within_noise,
    run_variance_audit,
    select_variance_slice,
)


def _item_ids(n: int) -> tuple[str, ...]:
    return tuple(f"i{i}" for i in range(n))


def _scores(item_ids: tuple[str, ...], *, pass_first: int) -> tuple[ItemScore, ...]:
    """Scores where the first ``pass_first`` items strict-pass and the rest fail."""
    return tuple(
        ItemScore(
            item_id=item_id,
            behavior_class="answer",
            behavior_match=True,
            cite_precision=1.0,
            cite_recall=1.0 if index < pass_first else 0.0,
            retrieval_hit_rate=1.0,
            strict_pass=index < pass_first,
        )
        for index, item_id in enumerate(item_ids)
    )


# --- slice selection -------------------------------------------------------


def test_variance_slice_is_seeded_and_reproducible() -> None:
    ids = _item_ids(40)
    a = select_variance_slice(ids, size=15, seed=42)
    b = select_variance_slice(ids, size=15, seed=42)
    assert a == b
    assert len(a) == 15
    assert set(a).issubset(set(ids))


def test_variance_slice_distinct_items_no_duplicates() -> None:
    ids = _item_ids(40)
    chosen = select_variance_slice(ids, size=15, seed=7)
    assert len(set(chosen)) == len(chosen)


def test_variance_slice_caps_at_population_size() -> None:
    ids = _item_ids(10)
    chosen = select_variance_slice(ids, size=15, seed=1)
    assert set(chosen) == set(ids)  # cannot sample more than exist


# --- the audit -------------------------------------------------------------


def test_audit_runs_each_arm_the_requested_number_of_repeats() -> None:
    ids = _item_ids(5)
    calls: list[tuple[str, int]] = []

    def run_once(*, arm: str, repeat: int) -> tuple[ItemScore, ...]:
        calls.append((arm, repeat))
        return _scores(ids, pass_first=3)

    audit = run_variance_audit(
        arms=("stuff", "agent"),
        run_once=run_once,
        repeats=5,
    )
    # 2 arms x 5 repeats = 10 runs.
    assert len(calls) == 10
    assert {arm for arm, _ in calls} == {"stuff", "agent"}
    assert {repeat for _, repeat in calls} == {0, 1, 2, 3, 4}
    assert set(audit.noise_floor_by_arm.keys()) == {"stuff", "agent"}


def test_constant_arm_has_a_zero_noise_floor() -> None:
    ids = _item_ids(5)

    def run_once(*, arm: str, repeat: int) -> tuple[ItemScore, ...]:
        _ = (arm, repeat)
        return _scores(ids, pass_first=3)  # identical every repeat

    audit = run_variance_audit(arms=("agent",), run_once=run_once, repeats=5)
    assert audit.noise_floor_by_arm["agent"].spread == 0.0


def test_noisy_arm_has_a_positive_noise_floor_equal_to_the_metric_spread() -> None:
    ids = _item_ids(10)
    # repeat r passes r of 10 → strict rates 0.0, 0.1, ... up to 0.4 over 5 repeats.
    per_repeat_pass = {0: 0, 1: 1, 2: 2, 3: 3, 4: 4}

    def run_once(*, arm: str, repeat: int) -> tuple[ItemScore, ...]:
        _ = arm
        return _scores(ids, pass_first=per_repeat_pass[repeat])

    audit = run_variance_audit(arms=("agent",), run_once=run_once, repeats=5)
    floor = audit.noise_floor_by_arm["agent"]
    # Spread is max - min of the per-repeat strict rates: 0.4 - 0.0 = 0.4.
    assert abs(floor.spread - 0.4) < 1e-9
    assert floor.min_rate == 0.0
    assert abs(floor.max_rate - 0.4) < 1e-9
    assert floor.repeats == 5


# --- within-noise labeling -------------------------------------------------


def test_gap_inside_the_combined_noise_floor_is_within_noise() -> None:
    stuff = NoiseFloor(arm="stuff", per_repeat_rates=(0.30, 0.40), min_rate=0.30, max_rate=0.40)
    agent = NoiseFloor(arm="agent", per_repeat_rates=(0.50, 0.62), min_rate=0.50, max_rate=0.62)
    # gap 0.10 is smaller than the larger arm floor (0.12) → within noise.
    assert is_within_noise(gap=0.10, floors=(stuff, agent)) is True


def test_gap_outside_the_noise_floor_is_not_within_noise() -> None:
    stuff = NoiseFloor(arm="stuff", per_repeat_rates=(0.30, 0.34), min_rate=0.30, max_rate=0.34)
    agent = NoiseFloor(arm="agent", per_repeat_rates=(0.80, 0.83), min_rate=0.80, max_rate=0.83)
    # gap 0.50 dwarfs both floors (0.04, 0.03) → real, not noise.
    assert is_within_noise(gap=0.50, floors=(stuff, agent)) is False


def test_within_noise_uses_absolute_gap_magnitude() -> None:
    stuff = NoiseFloor(arm="stuff", per_repeat_rates=(0.30, 0.45), min_rate=0.30, max_rate=0.45)
    agent = NoiseFloor(arm="agent", per_repeat_rates=(0.50, 0.55), min_rate=0.50, max_rate=0.55)
    # A negative gap of -0.10 is within a 0.15 floor by magnitude.
    assert is_within_noise(gap=-0.10, floors=(stuff, agent)) is True
