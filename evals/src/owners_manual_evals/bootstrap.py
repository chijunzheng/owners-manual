"""Paired-by-item bootstrap confidence intervals on an arm gap (issue #20 AC1).

CONTEXT.md ("Variance audit"): "arm gaps are paired-by-item with bootstrap CIs
over items". Every published gap (e.g. the agent-vs-naive-rag strict-pass delta)
carries an interval built here, so a gap is never reported as a bare point.

The resample is the percentile bootstrap, paired by item:

* draw ``n`` item indices WITH REPLACEMENT (``n`` = the item count);
* the SAME indices index both arms, so each resample preserves the per-item
  pairing the gap is measured over — this is why two arms must cover the same
  item ids (a paired CI over a mismatched set is meaningless);
* the gap statistic is recomputed on each resampled pair; the interval is the
  empirical ``[(1-c)/2, 1-(1-c)/2]`` percentiles of those resampled gaps.

The RNG is a :class:`random.Random` seeded from the caller, never the global
module RNG — so the interval is reproducible and no unseeded randomness reaches
the shipped path (a hard requirement of the issue's /tdd workflow).
"""

from __future__ import annotations

import random
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from .metrics import ItemScore

#: A per-arm scalar over a list of item scores (e.g. strict pass rate).
ArmStatistic = Callable[[tuple[ItemScore, ...]], float]


@dataclass(frozen=True, slots=True)
class ConfidenceInterval:
    """A paired-gap CI: the observed point estimate and its percentile bounds.

    ``point_estimate`` is the gap on the ACTUAL data (treatment minus baseline) —
    it is data, not RNG, so it never moves with the seed. ``low`` / ``high`` are
    the percentile bounds over the resampled gaps; ``confidence`` is the nominal
    coverage (e.g. 0.95). ``iterations`` records how many resamples produced it.
    """

    point_estimate: float
    low: float
    high: float
    confidence: float
    iterations: int

    @property
    def within(self) -> float:
        """Half-width proxy: the larger absolute distance from the point estimate
        to a bound. Handy when comparing a gap CI against a noise floor."""
        return max(abs(self.high - self.point_estimate), abs(self.point_estimate - self.low))


def _percentile(sorted_values: Sequence[float], fraction: float) -> float:
    """Linear-interpolated percentile of an already-sorted sequence.

    ``fraction`` is in ``[0, 1]``; matches numpy's default ``linear`` method so the
    interval is the conventional percentile bootstrap, not a nearest-rank variant.
    """
    if not sorted_values:
        raise ValueError("cannot take a percentile of an empty sequence")
    if len(sorted_values) == 1:
        return sorted_values[0]
    position = fraction * (len(sorted_values) - 1)
    lower = int(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    weight = position - lower
    return sorted_values[lower] * (1.0 - weight) + sorted_values[upper] * weight


def _paired_gap(
    baseline: Sequence[ItemScore],
    treatment: Sequence[ItemScore],
    statistic: ArmStatistic,
) -> float:
    return statistic(tuple(treatment)) - statistic(tuple(baseline))


def bootstrap_paired_gap_ci(
    *,
    baseline: Sequence[ItemScore],
    treatment: Sequence[ItemScore],
    statistic: ArmStatistic,
    iterations: int = 2000,
    seed: int,
    confidence: float = 0.95,
) -> ConfidenceInterval:
    """Percentile bootstrap CI for the gap ``statistic(treatment) - statistic(baseline)``.

    Both arms must cover the same item ids (paired by item); the resample draws
    item indices with replacement and applies them to BOTH arms so each replicate
    keeps the pairing. Raises ``ValueError`` on a mismatched item set, a
    non-positive ``iterations``, an empty item set, or a ``confidence`` outside
    ``(0, 1)``.
    """
    if iterations <= 0:
        raise ValueError("iterations must be a positive integer")
    if not 0.0 < confidence < 1.0:
        raise ValueError("confidence must be in the open interval (0, 1)")
    if not baseline or not treatment:
        raise ValueError("paired bootstrap needs at least one item per arm")

    baseline_by_id = {s.item_id: s for s in baseline}
    treatment_by_id = {s.item_id: s for s in treatment}
    if baseline_by_id.keys() != treatment_by_id.keys():
        raise ValueError("baseline and treatment must cover the same item ids (paired bootstrap)")

    # Pair the arms on a single item order so one resampled index hits both.
    item_ids = [s.item_id for s in baseline]
    paired_baseline = tuple(baseline_by_id[i] for i in item_ids)
    paired_treatment = tuple(treatment_by_id[i] for i in item_ids)

    point_estimate = _paired_gap(paired_baseline, paired_treatment, statistic)

    rng = random.Random(seed)
    n = len(item_ids)
    resampled_gaps: list[float] = []
    for _ in range(iterations):
        indices = [rng.randrange(n) for _ in range(n)]
        resampled_baseline = tuple(paired_baseline[i] for i in indices)
        resampled_treatment = tuple(paired_treatment[i] for i in indices)
        resampled_gaps.append(_paired_gap(resampled_baseline, resampled_treatment, statistic))

    resampled_gaps.sort()
    tail = (1.0 - confidence) / 2.0
    low = _percentile(resampled_gaps, tail)
    high = _percentile(resampled_gaps, 1.0 - tail)
    return ConfidenceInterval(
        point_estimate=point_estimate,
        low=low,
        high=high,
        confidence=confidence,
        iterations=iterations,
    )


def strict_pass_rate(scores: tuple[ItemScore, ...]) -> float:
    """The strict pass rate over a list of item scores — the headline gap statistic.

    Defined here (not only in the dashboards) so the bootstrap has a canonical,
    importable arm statistic and callers do not each re-roll their own.
    """
    return sum(1.0 if s.strict_pass else 0.0 for s in scores) / len(scores) if scores else 0.0


__all__ = [
    "ArmStatistic",
    "ConfidenceInterval",
    "bootstrap_paired_gap_ci",
    "strict_pass_rate",
]
