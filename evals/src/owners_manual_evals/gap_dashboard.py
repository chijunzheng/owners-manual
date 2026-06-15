"""The gap dashboard: bootstrap CIs, within-noise labels, dev/holdout columns (#20).

This is the statistical-honesty layer over the four-arm table (#18). It publishes
the arm GAPS — not bare deltas — with everything CONTEXT.md ("Variance audit",
"Dev/holdout split") demands:

* AC1 — every published gap carries a paired-by-item bootstrap CI
  (:func:`bootstrap_paired_gap_ci`, seeded), so a gap is reported as an interval,
  never a point;
* AC3 — when a variance audit is supplied, a gap whose magnitude sits inside the
  combined per-arm noise floor (:func:`is_within_noise`) is labeled within-noise;
  with no audit the label is ``None`` (unknown), never a false "real";
* AC5 — each arm's dev and holdout strict-pass rates sit side by side with their
  divergence (the overfit detector). The holdout column is present only when
  holdout scores are supplied — sealed from non-release tiers UPSTREAM by
  :mod:`eval_tier`, so its absence here is "not run at this tier", reported as
  ``None`` rather than a misleading zero.

The gaps published by default are each architecture's lift over the honest no-RAG
``stuff`` baseline, plus the agent-vs-naive-rag headline; the set is explicit
(:data:`DEFAULT_GAP_PAIRS`) so "every published gap" is a closed, testable list.
Slices are never blended into one scalar and there is no single overall number —
the same two CONTEXT.md rules every dashboard obeys.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .bootstrap import ConfidenceInterval, bootstrap_paired_gap_ci, strict_pass_rate
from .four_arm_dashboard import ARM_ORDER
from .metrics import ItemScore
from .variance_audit import NoiseFloor, VarianceAudit, is_within_noise

#: The gaps published by default, as ``(baseline_arm, treatment_arm)`` pairs.
#: Each non-baseline arm's lift over the honest no-RAG ``stuff`` floor, plus the
#: agent-vs-naive-rag architecture headline (CONTEXT.md: paired arms attribute
#: where lift comes from). Listed explicitly so "every published gap" is testable.
DEFAULT_GAP_PAIRS: tuple[tuple[str, str], ...] = (
    ("stuff", "stuff-oracle"),
    ("stuff", "naive-rag"),
    ("stuff", "agent"),
    ("naive-rag", "agent"),
)


@dataclass(frozen=True, slots=True)
class GapRow:
    """One published gap: the arm pair, its paired bootstrap CI, and the label.

    ``within_noise`` is ``True``/``False`` when a variance audit was supplied and
    ``None`` when it was not (the noise floor is simply unknown, not zero).
    """

    baseline_arm: str
    treatment_arm: str
    ci: ConfidenceInterval
    within_noise: bool | None


@dataclass(frozen=True, slots=True)
class SplitRow:
    """One arm's dev-vs-holdout strict pass, side by side (the overfit detector).

    ``holdout_strict_pass`` and ``divergence`` are ``None`` when no holdout scores
    were supplied — the holdout was not run at this tier (sealed upstream), which
    is distinct from a holdout rate that happens to be zero.
    """

    arm: str
    dev_strict_pass: float
    holdout_strict_pass: float | None
    #: dev minus holdout strict pass — positive means worse on the sealed holdout
    #: (the classic overfit-to-dev direction). ``None`` when holdout did not run.
    divergence: float | None


@dataclass(frozen=True, slots=True)
class GapDashboard:
    """The full gap dashboard: per-pair gap rows with CIs, plus dev/holdout rows."""

    gaps: tuple[GapRow, ...]
    split_rows: tuple[SplitRow, ...]
    confidence: float


def _noise_floors_for(
    pair: tuple[str, str],
    audit: VarianceAudit | None,
) -> tuple[NoiseFloor, ...]:
    if audit is None:
        return ()
    return tuple(audit.noise_floor_by_arm[arm] for arm in pair if arm in audit.noise_floor_by_arm)


def _gap_row(
    *,
    baseline_arm: str,
    treatment_arm: str,
    scores_by_arm: Mapping[str, Sequence[ItemScore]],
    seed: int,
    iterations: int,
    confidence: float,
    audit: VarianceAudit | None,
) -> GapRow:
    ci = bootstrap_paired_gap_ci(
        baseline=scores_by_arm[baseline_arm],
        treatment=scores_by_arm[treatment_arm],
        statistic=strict_pass_rate,
        iterations=iterations,
        seed=seed,
        confidence=confidence,
    )
    floors = _noise_floors_for((baseline_arm, treatment_arm), audit)
    within = is_within_noise(gap=ci.point_estimate, floors=floors) if audit is not None else None
    return GapRow(
        baseline_arm=baseline_arm,
        treatment_arm=treatment_arm,
        ci=ci,
        within_noise=within,
    )


def _split_row(
    arm: str,
    dev_scores: Mapping[str, Sequence[ItemScore]],
    holdout_scores: Mapping[str, Sequence[ItemScore]] | None,
) -> SplitRow:
    dev_rate = strict_pass_rate(tuple(dev_scores[arm]))
    if holdout_scores is None or arm not in holdout_scores:
        return SplitRow(
            arm=arm, dev_strict_pass=dev_rate, holdout_strict_pass=None, divergence=None
        )
    holdout_rate = strict_pass_rate(tuple(holdout_scores[arm]))
    return SplitRow(
        arm=arm,
        dev_strict_pass=dev_rate,
        holdout_strict_pass=holdout_rate,
        divergence=dev_rate - holdout_rate,
    )


def build_gap_dashboard(
    *,
    dev_scores: Mapping[str, Sequence[ItemScore]],
    holdout_scores: Mapping[str, Sequence[ItemScore]] | None = None,
    seed: int,
    iterations: int = 2000,
    confidence: float = 0.95,
    variance_audit: VarianceAudit | None = None,
    gap_pairs: Sequence[tuple[str, str]] = DEFAULT_GAP_PAIRS,
) -> GapDashboard:
    """Build the gap dashboard from per-arm dev (and optional holdout) scores.

    Every gap in ``gap_pairs`` gets a seeded paired bootstrap CI; when
    ``variance_audit`` is supplied each gap is also labeled within-noise or not.
    The dev/holdout split rows are emitted in :data:`ARM_ORDER`. Raises
    ``ValueError`` if a gap pair names an arm absent from ``dev_scores`` (so a
    typo cannot silently drop a published gap); the paired-item check is enforced
    per gap by :func:`bootstrap_paired_gap_ci`.
    """
    missing = {arm for pair in gap_pairs for arm in pair if arm not in dev_scores}
    if missing:
        raise ValueError(f"gap pairs reference arm(s) absent from dev scores: {sorted(missing)}")

    # Distinct seed per gap so two different pairs do not share a resample stream,
    # while the whole dashboard stays reproducible from the single caller seed.
    gaps = tuple(
        _gap_row(
            baseline_arm=baseline,
            treatment_arm=treatment,
            scores_by_arm=dev_scores,
            seed=seed + index,
            iterations=iterations,
            confidence=confidence,
            audit=variance_audit,
        )
        for index, (baseline, treatment) in enumerate(gap_pairs)
    )

    split_arms = [arm for arm in ARM_ORDER if arm in dev_scores]
    split_rows = tuple(_split_row(arm, dev_scores, holdout_scores) for arm in split_arms)
    return GapDashboard(gaps=gaps, split_rows=split_rows, confidence=confidence)


def _fmt_signed_pct(value: float) -> str:
    sign = "+" if value >= 0 else "-"
    return f"{sign}{abs(value):.2%}"


def _fmt_optional_pct(value: float | None) -> str:
    return "  sealed" if value is None else f"{value:>7.2%}"


def render_gap_dashboard(dashboard: GapDashboard, *, run_name: str) -> str:
    """Render the gap dashboard: per-gap CIs with within-noise labels, then the
    dev-vs-holdout columns. Honest by construction — a within-noise gap says so,
    and a sealed holdout is marked sealed, never shown as a zero."""
    confidence_pct = f"{dashboard.confidence:.0%}"
    lines = [
        f"=== {run_name} — arm gaps with paired bootstrap CIs ({confidence_pct} CI) ===",
        "",
        "Every published gap is paired by item and carries a bootstrap CI; a gap "
        "inside the variance-audit noise floor is labeled 'within noise' "
        "(measured, not suppressed). There is no single overall number.",
        "",
    ]

    ci_col = f"{confidence_pct} CI"
    gap_header = f"{'gap (treatment - baseline)':<34}{'Δ strict':>10}  {ci_col:>20}  label"
    lines.append(gap_header)
    lines.append("-" * len(gap_header))
    for gap in dashboard.gaps:
        pair = f"{gap.treatment_arm} - {gap.baseline_arm}"
        ci_text = f"[{_fmt_signed_pct(gap.ci.low)}, {_fmt_signed_pct(gap.ci.high)}]"
        if gap.within_noise is None:
            label = "(no audit)"
        elif gap.within_noise:
            label = "within noise"
        else:
            label = "real"
        lines.append(
            f"{pair:<34}{_fmt_signed_pct(gap.ci.point_estimate):>10}  {ci_text:>20}  {label}"
        )

    lines.append("")
    split_header = f"{'arm':<14}{'dev ✓':>8}  {'holdout ✓':>10}  {'divergence':>11}"
    lines.append("dev vs holdout (overfit detector) — holdout runs at the release tier only")
    lines.append(split_header)
    lines.append("-" * len(split_header))
    for row in dashboard.split_rows:
        divergence = "   sealed" if row.divergence is None else _fmt_signed_pct(row.divergence)
        lines.append(
            f"{row.arm:<14}{row.dev_strict_pass:>8.2%}  "
            f"{_fmt_optional_pct(row.holdout_strict_pass):>10}  {divergence:>11}"
        )

    lines.append("")
    lines.append(
        "Δ strict = treatment minus baseline strict pass rate, paired by item. "
        "A 'sealed' holdout column means the holdout was not run at this tier (it "
        "is sealed from iteration by construction); divergence is dev minus "
        "holdout — positive means worse on the sealed holdout."
    )
    return "\n".join(lines)


def render_noise_floor(audit: VarianceAudit, *, run_name: str) -> str:
    """Render the per-arm run-to-run noise floor the variance audit measured.

    Publishes the spread (max − min strict-pass rate over the repeats) that every
    'within noise' label is judged against, with the per-repeat rates so the
    threshold itself is auditable — not just the labels derived from it. Without
    this the CLI prints the verdicts but hides the bar they were measured against
    (CONTEXT.md: variance mode exists to *publish* the per-arm noise floor)."""
    lines = [
        f"=== {run_name} — per-arm noise floor (variance audit, x{audit.repeats}) ===",
        "",
        "Run-to-run spread of each arm's strict-pass rate with nothing changed but "
        "the model's own nondeterminism. A gap no larger than the spread of the arms "
        "it spans is the threshold for the 'within noise' labels.",
        "",
    ]
    header = f"{'arm':<14}{'noise floor':>12}  {'min ✓':>8}  {'max ✓':>8}  per-repeat ✓"
    lines.append(header)
    lines.append("-" * len(header))
    ordered = [arm for arm in ARM_ORDER if arm in audit.noise_floor_by_arm]
    extra = sorted(arm for arm in audit.noise_floor_by_arm if arm not in ARM_ORDER)
    for arm in (*ordered, *extra):
        floor = audit.noise_floor_by_arm[arm]
        rates = ", ".join(f"{rate:.2%}" for rate in floor.per_repeat_rates)
        lines.append(
            f"{arm:<14}{floor.spread:>12.2%}  {floor.min_rate:>8.2%}  "
            f"{floor.max_rate:>8.2%}  {rates}"
        )
    return "\n".join(lines)


__all__ = [
    "DEFAULT_GAP_PAIRS",
    "GapRow",
    "SplitRow",
    "GapDashboard",
    "build_gap_dashboard",
    "render_gap_dashboard",
    "render_noise_floor",
]
