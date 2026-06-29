"""Cohen's-κ calibration core for the judge (issue #19, ADR 0010 Decisions 1 & 3).

The judge (ADR 0008) is the dashboard's only subjective dimension, so it is trusted
exactly as far as measured human agreement says (CONTEXT.md, "Calibration slice").
This module is the PURE κ core: given paired (human, judge) binary credit decisions
per answer point — the ``human_point:<id>`` ↔ ``judge_point:<id>`` pairing of
Decision 1 — it computes everything Decision 3 publishes:

* **observed agreement** (the raw match rate);
* **positive / negative prevalence** — the pooled credited base rate across both
  raters, reported BESIDE κ because κ collapses under prevalence (a 95%-credit judge
  posts ~95% agreement and a near-zero κ — an artifact, not unreliability);
* **Cohen's κ**, pooled and **per behavior class** (the headline stratification);
* **a seeded-bootstrap CI on κ**, reusing :mod:`bootstrap`'s percentile machinery so
  the κ interval is built identically to the published gap CIs.

Everything here is pure and seeded (no global RNG, the issue's /tdd requirement);
the live Langfuse write-back lives in the thin live binding, uninstrumented.
"""

from __future__ import annotations

import random
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .bootstrap import ConfidenceInterval, _percentile

#: A single (human_credited, judge_credited) decision over one answer point.
Pair = tuple[bool, bool]


@dataclass(frozen=True, slots=True)
class PointAgreement:
    """One paired per-point decision: the human's ``human_point`` ↔ the judge's
    ``judge_point`` on the same (item, point), with the behavior class κ stratifies
    by. The agreement unit of ADR 0010 Decision 1."""

    item_id: str
    point_id: str
    behavior_class: str
    human_credited: bool
    judge_credited: bool

    @property
    def pair(self) -> Pair:
        return (self.human_credited, self.judge_credited)


@dataclass(frozen=True, slots=True)
class CalibrationResult:
    """The published calibration figure for one κ run (ADR 0010 Decision 3).

    κ NEVER travels alone: ``observed_agreement`` and the ``positive``/``negative``
    prevalence sit beside it (the prevalence guard), ``kappa_ci`` is its seeded
    bootstrap interval, and ``per_class_kappa`` is the headline stratification by
    behavior class. ``per_class_kappa`` is read-only by contract (never mutated)."""

    kappa: float
    observed_agreement: float
    positive_prevalence: float
    negative_prevalence: float
    kappa_ci: ConfidenceInterval
    per_class_kappa: Mapping[str, float]
    n_decisions: int


def _require_pairs(pairs: Sequence[Pair]) -> None:
    if not pairs:
        raise ValueError("Cohen's κ needs at least one paired decision")


def require_verdict(
    verdicts: Mapping[str, Mapping[str, object]],
    *,
    item_id: str,
    point_id: str,
) -> bool:
    """Look up an external judge verdict for one point and require a JSON boolean.

    The labels file is schema-validated (``calibration_labels.parse_labels``), but
    the Claude / Gemini verdict files are external raw JSON. A non-boolean scalar —
    notably the string ``"false"``, which :func:`bool` coerces to ``True`` — would
    silently credit a negative verdict and inflate κ and prevalence. Fail loud on a
    missing (item, point) or a non-``bool`` value instead of coercing. Ints (incl.
    ``0`` / ``1``) are rejected too: a JSON boolean is the only honest credit signal.
    """
    try:
        value = verdicts[item_id][point_id]
    except (KeyError, TypeError) as error:
        raise ValueError(f"judge verdict missing for ({item_id!r}, {point_id!r})") from error
    if not isinstance(value, bool):
        raise ValueError(
            f"judge verdict for ({item_id!r}, {point_id!r}) must be a JSON boolean, "
            f"got {type(value).__name__} {value!r}"
        )
    return value


def observed_agreement(pairs: Sequence[Pair]) -> float:
    """The raw match rate ``p_o``: the fraction of points the two raters agree on."""
    _require_pairs(pairs)
    return sum(1 for human, judge in pairs if human == judge) / len(pairs)


def positive_prevalence(pairs: Sequence[Pair]) -> float:
    """The pooled credited base rate across BOTH raters (Decision 3's prevalence).

    Defined over all ``2n`` individual rater decisions, so a slice both raters
    credit heavily reads near 1.0 — exactly the imbalance that drives κ's
    chance-agreement collapse, surfaced beside κ rather than hidden."""
    _require_pairs(pairs)
    credited = sum(int(human) + int(judge) for human, judge in pairs)
    return credited / (2 * len(pairs))


def cohen_kappa(pairs: Sequence[Pair]) -> float:
    """Cohen's κ for the paired binary decisions.

    ``κ = (p_o - p_e) / (1 - p_e)`` with ``p_e`` the chance agreement from the two
    raters' marginals. When ``p_e == 1`` (both raters assign every point to a single
    category) κ is undefined; by documented convention this returns ``1.0`` for
    perfect observed agreement and ``0.0`` otherwise, never dividing by zero.
    """
    _require_pairs(pairs)
    n = len(pairs)
    p_o = observed_agreement(pairs)

    human_pos = sum(1 for human, _ in pairs if human) / n
    judge_pos = sum(1 for _, judge in pairs if judge) / n
    p_e = human_pos * judge_pos + (1.0 - human_pos) * (1.0 - judge_pos)

    if p_e >= 1.0:
        return 1.0 if p_o >= 1.0 else 0.0
    return (p_o - p_e) / (1.0 - p_e)


def bootstrap_kappa_ci(
    pairs: Sequence[Pair],
    *,
    seed: int,
    iterations: int = 2000,
    confidence: float = 0.95,
) -> ConfidenceInterval:
    """Seeded percentile-bootstrap CI on κ, reusing :mod:`bootstrap`'s machinery.

    Draws ``n`` point-decision indices WITH REPLACEMENT from a caller-seeded
    :class:`random.Random` (never the global RNG), recomputes κ on each resample,
    and takes the empirical percentiles — the same percentile bootstrap
    :func:`bootstrap.bootstrap_paired_gap_ci` applies to arm gaps. The
    ``point_estimate`` is the observed κ on the full set (data, not RNG). Raises
    ``ValueError`` on empty input, a non-positive ``iterations``, or a ``confidence``
    outside ``(0, 1)``.
    """
    _require_pairs(pairs)
    if iterations <= 0:
        raise ValueError("iterations must be a positive integer")
    if not 0.0 < confidence < 1.0:
        raise ValueError("confidence must be in the open interval (0, 1)")

    materialized = tuple(pairs)
    point_estimate = cohen_kappa(materialized)

    rng = random.Random(seed)
    n = len(materialized)
    resampled: list[float] = []
    for _ in range(iterations):
        sample = tuple(materialized[rng.randrange(n)] for _ in range(n))
        resampled.append(cohen_kappa(sample))

    resampled.sort()
    tail = (1.0 - confidence) / 2.0
    return ConfidenceInterval(
        point_estimate=point_estimate,
        low=_percentile(resampled, tail),
        high=_percentile(resampled, 1.0 - tail),
        confidence=confidence,
        iterations=iterations,
    )


def compute_calibration(
    agreements: Sequence[PointAgreement],
    *,
    seed: int,
    iterations: int = 2000,
    confidence: float = 0.95,
) -> CalibrationResult:
    """Compute the full Decision-3 calibration figure from paired point agreements.

    Pools every (item, point) decision for the headline κ, observed agreement,
    prevalence, and the seeded bootstrap CI; and stratifies κ by behavior class for
    the per-class headline. Raises ``ValueError`` on empty input.
    """
    if not agreements:
        raise ValueError("calibration needs at least one paired point agreement")

    pairs = [agreement.pair for agreement in agreements]

    per_class: dict[str, float] = {}
    by_class: dict[str, list[Pair]] = {}
    for agreement in agreements:
        by_class.setdefault(agreement.behavior_class, []).append(agreement.pair)
    for behavior_class, class_pairs in by_class.items():
        per_class[behavior_class] = cohen_kappa(class_pairs)

    pos = positive_prevalence(pairs)
    return CalibrationResult(
        kappa=cohen_kappa(pairs),
        observed_agreement=observed_agreement(pairs),
        positive_prevalence=pos,
        negative_prevalence=1.0 - pos,
        kappa_ci=bootstrap_kappa_ci(pairs, seed=seed, iterations=iterations, confidence=confidence),
        per_class_kappa=per_class,
        n_decisions=len(pairs),
    )


__all__ = [
    "Pair",
    "PointAgreement",
    "CalibrationResult",
    "observed_agreement",
    "positive_prevalence",
    "cohen_kappa",
    "bootstrap_kappa_ci",
    "compute_calibration",
    "require_verdict",
]
