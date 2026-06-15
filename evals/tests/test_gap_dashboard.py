"""Gap-dashboard tests (issue #20 AC1, AC3, AC5).

The dashboard surface that publishes arm GAPS with the statistical honesty #20
requires:

* AC1 — every published arm gap carries a paired bootstrap CI (seeded);
* AC3 — a gap whose magnitude sits inside the variance-audit noise floor is
  labeled within-noise;
* AC5 — each arm's dev and holdout strict-pass rates sit SIDE BY SIDE with their
  divergence, and the holdout column is present only when holdout scores are
  supplied (it is sealed from non-release tiers by construction upstream).

The bootstrap and the audit are the seeded primitives from :mod:`bootstrap` and
:mod:`variance_audit`; here they are pinned at the dashboard boundary.
"""

from __future__ import annotations

from owners_manual_evals.gap_dashboard import (
    DEFAULT_GAP_PAIRS,
    build_gap_dashboard,
    render_gap_dashboard,
    render_noise_floor,
)
from owners_manual_evals.metrics import ItemScore
from owners_manual_evals.variance_audit import NoiseFloor, VarianceAudit


def _scores(prefix: str, *, n: int, pass_first: int) -> tuple[ItemScore, ...]:
    return tuple(
        ItemScore(
            item_id=f"{prefix}{i}",
            behavior_class="answer",
            behavior_match=True,
            cite_precision=1.0,
            cite_recall=1.0 if i < pass_first else 0.0,
            retrieval_hit_rate=1.0,
            strict_pass=i < pass_first,
        )
        for i in range(n)
    )


def _arm_scores(*, stuff: int, oracle: int, naive: int, agent: int, n: int = 10) -> dict:
    # All four arms cover the SAME item ids (paired) — same prefix per item index.
    def with_ids(pass_first: int) -> tuple[ItemScore, ...]:
        return tuple(
            ItemScore(
                item_id=f"i{i}",
                behavior_class="answer",
                behavior_match=True,
                cite_precision=1.0,
                cite_recall=1.0 if i < pass_first else 0.0,
                retrieval_hit_rate=1.0,
                strict_pass=i < pass_first,
            )
            for i in range(n)
        )

    return {
        "stuff": with_ids(stuff),
        "stuff-oracle": with_ids(oracle),
        "naive-rag": with_ids(naive),
        "agent": with_ids(agent),
    }


def test_every_published_gap_carries_a_bootstrap_ci() -> None:
    dev = _arm_scores(stuff=2, oracle=4, naive=5, agent=8)
    dashboard = build_gap_dashboard(dev_scores=dev, seed=1, iterations=300)
    assert len(dashboard.gaps) == len(DEFAULT_GAP_PAIRS)
    for gap in dashboard.gaps:
        # A CI is present and brackets the point estimate.
        assert gap.ci.low <= gap.ci.point_estimate <= gap.ci.high
        assert gap.ci.iterations == 300


def test_gap_point_estimate_matches_the_observed_strict_pass_delta() -> None:
    dev = _arm_scores(stuff=2, oracle=4, naive=5, agent=8)
    dashboard = build_gap_dashboard(dev_scores=dev, seed=1, iterations=200)
    by_pair = {(g.baseline_arm, g.treatment_arm): g for g in dashboard.gaps}
    # agent (0.8) - stuff (0.2) = +0.6.
    assert abs(by_pair[("stuff", "agent")].ci.point_estimate - 0.6) < 1e-9
    # agent (0.8) - naive-rag (0.5) = +0.3 (the architecture headline).
    assert abs(by_pair[("naive-rag", "agent")].ci.point_estimate - 0.3) < 1e-9


def test_gap_dashboard_is_seeded_and_reproducible() -> None:
    dev = _arm_scores(stuff=2, oracle=4, naive=5, agent=8)
    a = build_gap_dashboard(dev_scores=dev, seed=5, iterations=300)
    b = build_gap_dashboard(dev_scores=dev, seed=5, iterations=300)
    a_bounds = [(g.ci.low, g.ci.high) for g in a.gaps]
    b_bounds = [(g.ci.low, g.ci.high) for g in b.gaps]
    assert a_bounds == b_bounds


def test_gap_inside_noise_floor_is_labeled_within_noise() -> None:
    # naive-rag and agent both at 0.5 → a zero gap; any positive floor covers it.
    dev = _arm_scores(stuff=2, oracle=4, naive=5, agent=5)
    audit = VarianceAudit(
        noise_floor_by_arm={
            "stuff": NoiseFloor("stuff", (0.20, 0.25), 0.20, 0.25),
            "stuff-oracle": NoiseFloor("stuff-oracle", (0.40, 0.45), 0.40, 0.45),
            "naive-rag": NoiseFloor("naive-rag", (0.50, 0.62), 0.50, 0.62),
            "agent": NoiseFloor("agent", (0.50, 0.60), 0.50, 0.60),
        },
        repeats=5,
    )
    dashboard = build_gap_dashboard(dev_scores=dev, seed=1, iterations=200, variance_audit=audit)
    by_pair = {(g.baseline_arm, g.treatment_arm): g for g in dashboard.gaps}
    # agent - naive-rag is 0.0, inside the ~0.12 floor → within noise.
    assert by_pair[("naive-rag", "agent")].within_noise is True
    # agent - stuff is +0.3, far outside the floor → a real gap.
    assert by_pair[("stuff", "agent")].within_noise is False


def test_without_an_audit_no_gap_is_labeled_within_noise() -> None:
    dev = _arm_scores(stuff=5, oracle=5, naive=5, agent=5)  # all gaps are zero
    dashboard = build_gap_dashboard(dev_scores=dev, seed=1, iterations=100)
    # No noise floor supplied → within_noise is unknown (None), not a false True.
    assert all(g.within_noise is None for g in dashboard.gaps)


def test_dev_and_holdout_strict_pass_appear_side_by_side() -> None:
    dev = _arm_scores(stuff=2, oracle=4, naive=5, agent=8)
    holdout = _arm_scores(stuff=1, oracle=2, naive=2, agent=3, n=5)
    dashboard = build_gap_dashboard(dev_scores=dev, holdout_scores=holdout, seed=1, iterations=100)
    by_arm = {row.arm: row for row in dashboard.split_rows}
    # agent: dev 8/10 = 0.8, holdout 3/5 = 0.6, divergence 0.2.
    assert abs(by_arm["agent"].dev_strict_pass - 0.8) < 1e-9
    assert abs(by_arm["agent"].holdout_strict_pass - 0.6) < 1e-9
    assert abs(by_arm["agent"].divergence - 0.2) < 1e-9


def test_holdout_column_absent_when_no_holdout_scores_supplied() -> None:
    dev = _arm_scores(stuff=2, oracle=4, naive=5, agent=8)
    dashboard = build_gap_dashboard(dev_scores=dev, seed=1, iterations=100)
    by_arm = {row.arm: row for row in dashboard.split_rows}
    # Holdout sealed (not run at this tier): the column reads None, never a zero.
    assert by_arm["agent"].holdout_strict_pass is None
    assert by_arm["agent"].divergence is None


def test_render_states_paired_ci_and_within_noise_and_dev_holdout() -> None:
    dev = _arm_scores(stuff=2, oracle=4, naive=5, agent=5)
    holdout = _arm_scores(stuff=1, oracle=2, naive=2, agent=3, n=5)
    audit = VarianceAudit(
        noise_floor_by_arm={
            "stuff": NoiseFloor("stuff", (0.20, 0.25), 0.20, 0.25),
            "stuff-oracle": NoiseFloor("stuff-oracle", (0.40, 0.45), 0.40, 0.45),
            "naive-rag": NoiseFloor("naive-rag", (0.50, 0.62), 0.50, 0.62),
            "agent": NoiseFloor("agent", (0.50, 0.60), 0.50, 0.60),
        },
        repeats=5,
    )
    text = render_gap_dashboard(
        build_gap_dashboard(
            dev_scores=dev, holdout_scores=holdout, seed=1, iterations=200, variance_audit=audit
        ),
        run_name="variance-v0",
    )
    assert "variance-v0" in text
    assert "95% CI" in text or "CI" in text
    assert "within noise" in text.lower()
    assert "holdout" in text.lower() and "dev" in text.lower()


def test_render_noise_floor_publishes_each_arms_measured_spread() -> None:
    # The 'within noise' labels above are only auditable if the floor MAGNITUDES
    # they are judged against are published too — a reader checking a verdict needs
    # the threshold, not just the label. (Codex on PR #47: the CLI rendered the
    # labels but never the per-arm noise floors behind them.)
    audit = VarianceAudit(
        noise_floor_by_arm={
            "stuff": NoiseFloor("stuff", (0.50, 0.50, 0.50), 0.50, 0.50),  # constant → 0 floor
            "agent": NoiseFloor("agent", (0.40, 0.55, 0.60), 0.40, 0.60),  # spread 0.20
        },
        repeats=3,
    )
    text = render_noise_floor(audit, run_name="variance-v0")
    assert "variance-v0" in text
    assert "noise floor" in text.lower()
    # Both arms are named, in canonical ARM_ORDER.
    assert text.index("stuff") < text.index("agent")
    # The measured spread (the floor itself) is published per arm.
    assert "0.00%" in text  # the constant arm's floor is zero
    assert "20.00%" in text  # the agent arm's measured spread (0.60 − 0.40)
    # The per-repeat rates are shown so the threshold is auditable, and the repeat
    # count is stated.
    assert "55.00%" in text  # an agent per-repeat rate that is neither min/max/spread
    assert "x3" in text


def test_rejects_arms_not_covering_the_same_items() -> None:
    dev = _arm_scores(stuff=2, oracle=4, naive=5, agent=8)
    dev["agent"] = _scores("z", n=3, pass_first=1)  # different item ids
    try:
        build_gap_dashboard(dev_scores=dev, seed=1, iterations=50)
    except ValueError as error:
        assert "paired" in str(error).lower() or "same item" in str(error).lower()
    else:  # pragma: no cover
        raise AssertionError("expected a ValueError for mismatched item sets")
