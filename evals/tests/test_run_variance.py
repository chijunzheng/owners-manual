"""Variance-mode runner tests (issue #20 AC1-AC5, integration).

The one command that ties the seeded primitives together: run the audit slice x5
to get the per-arm noise floor, score every arm over the dev split (paired by
item), optionally score the holdout (release tier only), and emit the gap
dashboard with bootstrap CIs, within-noise labels, and dev/holdout columns. The
per-repeat run and the per-split run are injected, so the whole loop is
unit-tested offline against fakes — never a live model.
"""

from __future__ import annotations

from owners_manual_evals.four_arm_dashboard import ARM_ORDER
from owners_manual_evals.metrics import ItemScore
from owners_manual_evals.run_variance import run_variance_comparison


def _scores(item_ids: tuple[str, ...], *, pass_first: int) -> tuple[ItemScore, ...]:
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


_DEV_IDS = tuple(f"d{i}" for i in range(10))
_HOLDOUT_IDS = tuple(f"h{i}" for i in range(5))
_PASS_BY_ARM = {"stuff": 2, "stuff-oracle": 4, "naive-rag": 5, "agent": 8}


def _score_split(*, arm: str, item_ids: tuple[str, ...]) -> tuple[ItemScore, ...]:
    return _scores(item_ids, pass_first=_PASS_BY_ARM[arm])


def _run_audit_once(*, arm: str, repeat: int) -> tuple[ItemScore, ...]:
    # Deterministic per (arm, repeat): a small jitter so the floor is positive.
    jitter = repeat % 2
    return _scores(_DEV_IDS, pass_first=_PASS_BY_ARM[arm] + jitter)


def test_run_emits_a_gap_dashboard_with_cis_for_every_default_gap() -> None:
    result = run_variance_comparison(
        arms=ARM_ORDER,
        dev_item_ids=_DEV_IDS,
        holdout_item_ids=None,
        score_split=_score_split,
        run_audit_once=_run_audit_once,
        repeats=5,
        seed=3,
        iterations=200,
    )
    assert len(result.dashboard.gaps) == 4
    for gap in result.dashboard.gaps:
        assert gap.ci.low <= gap.ci.point_estimate <= gap.ci.high


def test_run_publishes_the_per_arm_noise_floor() -> None:
    result = run_variance_comparison(
        arms=ARM_ORDER,
        dev_item_ids=_DEV_IDS,
        holdout_item_ids=None,
        score_split=_score_split,
        run_audit_once=_run_audit_once,
        repeats=5,
        seed=3,
        iterations=100,
    )
    assert set(result.variance_audit.noise_floor_by_arm.keys()) == set(ARM_ORDER)
    # The jitter is 0/1 item over 10 → a 0.1 spread per arm.
    for floor in result.variance_audit.noise_floor_by_arm.values():
        assert abs(floor.spread - 0.1) < 1e-9


def test_within_noise_labels_come_from_the_measured_floor() -> None:
    # naive-rag and agent both pass 5/10 on the dev split → a zero gap, which the
    # measured ~0.1 floor covers → within noise.
    pass_by_arm = {"stuff": 2, "stuff-oracle": 4, "naive-rag": 5, "agent": 5}

    def score_split(*, arm: str, item_ids: tuple[str, ...]) -> tuple[ItemScore, ...]:
        return _scores(item_ids, pass_first=pass_by_arm[arm])

    def run_audit_once(*, arm: str, repeat: int) -> tuple[ItemScore, ...]:
        return _scores(_DEV_IDS, pass_first=pass_by_arm[arm] + (repeat % 2))

    result = run_variance_comparison(
        arms=ARM_ORDER,
        dev_item_ids=_DEV_IDS,
        holdout_item_ids=None,
        score_split=score_split,
        run_audit_once=run_audit_once,
        repeats=5,
        seed=1,
        iterations=200,
    )
    by_pair = {(g.baseline_arm, g.treatment_arm): g for g in result.dashboard.gaps}
    assert by_pair[("naive-rag", "agent")].within_noise is True


def test_holdout_split_is_scored_and_appears_side_by_side() -> None:
    result = run_variance_comparison(
        arms=ARM_ORDER,
        dev_item_ids=_DEV_IDS,
        holdout_item_ids=_HOLDOUT_IDS,
        score_split=_score_split,
        run_audit_once=_run_audit_once,
        repeats=5,
        seed=3,
        iterations=100,
    )
    by_arm = {row.arm: row for row in result.dashboard.split_rows}
    # agent dev 8/10 = 0.8; holdout 8/5 capped → agent passes all 5 = 1.0.
    assert abs(by_arm["agent"].dev_strict_pass - 0.8) < 1e-9
    assert by_arm["agent"].holdout_strict_pass is not None
    assert by_arm["agent"].divergence is not None


def test_no_holdout_leaves_the_split_column_sealed() -> None:
    result = run_variance_comparison(
        arms=ARM_ORDER,
        dev_item_ids=_DEV_IDS,
        holdout_item_ids=None,
        score_split=_score_split,
        run_audit_once=_run_audit_once,
        repeats=5,
        seed=3,
        iterations=100,
    )
    by_arm = {row.arm: row for row in result.dashboard.split_rows}
    assert by_arm["agent"].holdout_strict_pass is None
    assert by_arm["agent"].divergence is None


def test_run_is_seeded_and_reproducible() -> None:
    kwargs = dict(
        arms=ARM_ORDER,
        dev_item_ids=_DEV_IDS,
        holdout_item_ids=None,
        score_split=_score_split,
        run_audit_once=_run_audit_once,
        repeats=5,
        seed=9,
        iterations=200,
    )
    a = run_variance_comparison(**kwargs)
    b = run_variance_comparison(**kwargs)
    a_bounds = [(g.ci.low, g.ci.high) for g in a.dashboard.gaps]
    b_bounds = [(g.ci.low, g.ci.high) for g in b.dashboard.gaps]
    assert a_bounds == b_bounds
