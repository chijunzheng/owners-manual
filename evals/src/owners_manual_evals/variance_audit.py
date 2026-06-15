"""Variance audit and the per-arm noise floor (issue #20 AC2, AC3).

CONTEXT.md ("Variance audit"): "A ~15-item slice run x5 per release to publish
the per-arm run-to-run noise floor. All other runs are n=1 per item; arm gaps are
paired-by-item with bootstrap CIs over items, and any gap inside the noise floor
is labeled 'within noise'. Exists because current models expose no temperature
control — variance is measured, not suppressed."

Two pieces live here:

* :func:`run_variance_audit` — runs each arm ``repeats`` times over the audit
  slice and records, per arm, the run-to-run spread of its headline metric (strict
  pass rate). The spread IS the noise floor: how far that arm's number moves when
  nothing changes but the model's own nondeterminism.
* :func:`is_within_noise` — labels a gap "within noise" when its magnitude does
  not exceed the noise floor of the arms it spans, so the dashboard can flag a
  gap that the run-to-run jitter could itself have produced.

The audit SLICE is sampled with a seeded :class:`random.Random` (never the global
RNG), so a release samples the same ~15 items reproducibly. The per-repeat run is
injected (:data:`RunOnce`), so the audit is unit-tested offline; the live binding
drives the real four arms ``repeats`` times.
"""

from __future__ import annotations

import random
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from .metrics import ItemScore

#: Run one arm once for a given repeat index, returning that repeat's item scores.
RunOnce = Callable[..., tuple[ItemScore, ...]]


@dataclass(frozen=True, slots=True)
class NoiseFloor:
    """One arm's run-to-run noise floor over the variance-audit repeats.

    ``per_repeat_rates`` are the arm's strict pass rates, one per repeat;
    ``min_rate`` / ``max_rate`` bracket them; :attr:`spread` is the floor itself.
    """

    arm: str
    per_repeat_rates: tuple[float, ...]
    min_rate: float
    max_rate: float

    @property
    def spread(self) -> float:
        """The run-to-run noise floor: ``max_rate - min_rate``. Zero for a constant
        arm, so a gap is only ever excused by jitter the arm actually exhibited."""
        return self.max_rate - self.min_rate

    @property
    def repeats(self) -> int:
        return len(self.per_repeat_rates)


@dataclass(frozen=True, slots=True)
class VarianceAudit:
    """The audit result: the per-arm noise floor, keyed by arm."""

    noise_floor_by_arm: dict[str, NoiseFloor]
    repeats: int


def _strict_rate(scores: Sequence[ItemScore]) -> float:
    return sum(1.0 if s.strict_pass else 0.0 for s in scores) / len(scores) if scores else 0.0


def select_variance_slice(
    item_ids: Sequence[str],
    *,
    size: int,
    seed: int,
) -> tuple[str, ...]:
    """Seeded ~``size``-item audit slice drawn without replacement from ``item_ids``.

    Reproducible from the seed (no global RNG) so a release re-samples the same
    slice; caps at the population size when fewer than ``size`` items exist. Items
    are returned in their sampled order, which is itself a function of the seed.
    """
    if size <= 0:
        raise ValueError("variance-audit slice size must be a positive integer")
    population = list(dict.fromkeys(item_ids))  # de-dup, preserve first-seen order
    rng = random.Random(seed)
    k = min(size, len(population))
    return tuple(rng.sample(population, k))


def run_variance_audit(
    *,
    arms: Sequence[str],
    run_once: RunOnce,
    repeats: int = 5,
) -> VarianceAudit:
    """Run each arm ``repeats`` times and record its run-to-run noise floor.

    ``run_once(arm=..., repeat=...)`` returns one repeat's item scores for an arm;
    the audit recomputes the arm's strict pass rate per repeat and takes the
    min/max spread as the floor. Raises ``ValueError`` for non-positive
    ``repeats`` or an empty arm list.
    """
    if repeats <= 0:
        raise ValueError("variance audit needs a positive number of repeats")
    if not arms:
        raise ValueError("variance audit needs at least one arm")

    floors: dict[str, NoiseFloor] = {}
    for arm in arms:
        rates = tuple(_strict_rate(run_once(arm=arm, repeat=repeat)) for repeat in range(repeats))
        floors[arm] = NoiseFloor(
            arm=arm,
            per_repeat_rates=rates,
            min_rate=min(rates),
            max_rate=max(rates),
        )
    return VarianceAudit(noise_floor_by_arm=floors, repeats=repeats)


def combined_noise_floor(floors: Sequence[NoiseFloor]) -> float:
    """The noise floor a gap between these arms must clear to count as real.

    Taken as the LARGEST single-arm spread among the involved arms: a gap is only
    excused as jitter when it is no bigger than the biggest run-to-run swing one of
    the two arms exhibits on its own. Empty input yields a zero floor (nothing to
    excuse the gap)."""
    return max((floor.spread for floor in floors), default=0.0)


def is_within_noise(*, gap: float, floors: Sequence[NoiseFloor]) -> bool:
    """True when ``|gap|`` does not exceed the combined noise floor of ``floors``.

    A within-noise gap is one the run-to-run jitter could itself have produced, so
    the dashboard labels it "within noise" rather than claiming a real difference.
    The sign of the gap is irrelevant — magnitude is what the floor bounds.
    """
    return abs(gap) <= combined_noise_floor(floors)


__all__ = [
    "RunOnce",
    "NoiseFloor",
    "VarianceAudit",
    "select_variance_slice",
    "run_variance_audit",
    "combined_noise_floor",
    "is_within_noise",
]
