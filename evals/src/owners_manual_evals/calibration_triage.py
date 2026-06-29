"""Disagreement triage + recompute-once driver (issue #19, ADR 0010 Decision 4).

Calibration can find that the judge and human disagree because the answer POINT is
ambiguous, not because the judge is unreliable. Decision 4 triages every judge↔human
mismatch into three buckets and corrects ONCE:

* ``rubric-wrong`` — the point is ambiguous; the golden item is edited on dev (the
  same verdict the :mod:`disposition` domain spends on a failed item — shared
  vocabulary), and the clarified gold label is applied;
* ``human-error`` — the human mislabeled; relabel the human side;
* ``judge-error`` — the judge is wrong; nothing is relabeled and the mismatch COUNTS
  AGAINST the judge.

The corrections (rubric-wrong + human-error) are applied **once** and κ is recomputed
**once** — never iterated rubric→recompute until κ clears a bar, which would overfit
the instrument to its own validation set (the rejected alternative). This module is
pure: it only ever relabels the HUMAN side, so a correction can never silently flip
the judge's frozen verdict.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from .calibration import CalibrationResult, PointAgreement, compute_calibration

#: The three triage buckets. ``rubric-wrong`` shares :mod:`disposition`'s meaning
#: (the golden set's own bug); ``human-error`` relabels; ``judge-error`` stands and
#: counts against the judge.
TriageBucket = Literal["rubric-wrong", "human-error", "judge-error"]

#: The buckets whose correction relabels the human/gold side (applied once). A
#: ``judge-error`` is deliberately absent — it never relabels anything.
_RELABEL_BUCKETS: frozenset[str] = frozenset({"rubric-wrong", "human-error"})


@dataclass(frozen=True, slots=True)
class Mismatch:
    """One judge↔human disagreement on a single answer point."""

    item_id: str
    point_id: str
    behavior_class: str
    human_credited: bool
    judge_credited: bool


@dataclass(frozen=True, slots=True)
class Correction:
    """A triage decision for one mismatch: its bucket and, for a relabel bucket, the
    corrected human/gold credit. ``corrected_human_credited`` MUST be set for
    ``rubric-wrong``/``human-error`` and MUST be ``None`` for ``judge-error`` (which
    never relabels — that is how the judge's verdict can never be silently flipped)."""

    item_id: str
    point_id: str
    bucket: TriageBucket
    corrected_human_credited: bool | None = None


@dataclass(frozen=True, slots=True)
class TriagedMismatch:
    """A mismatch paired with the bucket it was triaged into."""

    mismatch: Mismatch
    bucket: TriageBucket


@dataclass(frozen=True, slots=True)
class TriageReport:
    """Every mismatch, triaged. ``bucket_counts`` is the per-bucket tally the
    dashboard publishes (judge-error counts against the judge)."""

    triaged: tuple[TriagedMismatch, ...]
    bucket_counts: Mapping[str, int]


@dataclass(frozen=True, slots=True)
class RecomputeOnce:
    """The recompute-once result: κ BEFORE the corrections, κ AFTER applying them
    once, the triage report, and the singly-corrected agreements. There is no
    iteration history — by construction the corrections are applied exactly once."""

    before: CalibrationResult
    after: CalibrationResult
    report: TriageReport
    corrected_agreements: tuple[PointAgreement, ...]


def enumerate_mismatches(agreements: Sequence[PointAgreement]) -> tuple[Mismatch, ...]:
    """Every (item, point) where the human and the judge disagree, in input order."""
    return tuple(
        Mismatch(
            item_id=a.item_id,
            point_id=a.point_id,
            behavior_class=a.behavior_class,
            human_credited=a.human_credited,
            judge_credited=a.judge_credited,
        )
        for a in agreements
        if a.human_credited != a.judge_credited
    )


def _validate_correction(correction: Correction) -> None:
    """A relabel bucket needs a corrected value; ``judge-error`` forbids one."""
    if correction.bucket in _RELABEL_BUCKETS:
        if correction.corrected_human_credited is None:
            raise ValueError(
                f"{correction.bucket} correction for {correction.item_id}/"
                f"{correction.point_id} requires a corrected_human_credited value"
            )
    elif correction.corrected_human_credited is not None:
        raise ValueError(
            f"judge-error correction for {correction.item_id}/{correction.point_id} "
            "may not carry a corrected_human_credited (a judge-error never relabels)"
        )


def apply_corrections(
    agreements: Sequence[PointAgreement],
    corrections: Sequence[Correction],
) -> tuple[PointAgreement, ...]:
    """Apply the corrections ONCE, immutably, returning new agreements.

    A relabel bucket (``rubric-wrong``/``human-error``) sets the HUMAN side to its
    corrected value; ``judge-error`` changes nothing. The judge's verdict is never
    touched by any bucket. Every correction must target an actual mismatch (a
    correction on an agreeing point is a caller bug and raises). Input is never
    mutated — :class:`PointAgreement` is frozen and new values are built.
    """
    mismatch_keys = {(m.item_id, m.point_id) for m in enumerate_mismatches(agreements)}
    by_key: dict[tuple[str, str], Correction] = {}
    for correction in corrections:
        _validate_correction(correction)
        key = (correction.item_id, correction.point_id)
        if key not in mismatch_keys:
            raise ValueError(
                f"correction for {key} targets no judge↔human mismatch; corrections "
                "triage mismatches only (ADR 0010 Decision 4)"
            )
        by_key[key] = correction

    corrected: list[PointAgreement] = []
    for agreement in agreements:
        correction = by_key.get((agreement.item_id, agreement.point_id))
        if correction is not None and correction.bucket in _RELABEL_BUCKETS:
            corrected.append(
                PointAgreement(
                    item_id=agreement.item_id,
                    point_id=agreement.point_id,
                    behavior_class=agreement.behavior_class,
                    human_credited=bool(correction.corrected_human_credited),
                    judge_credited=agreement.judge_credited,  # judge always stands
                )
            )
        else:
            corrected.append(agreement)
    return tuple(corrected)


def _build_report(
    agreements: Sequence[PointAgreement],
    corrections: Sequence[Correction],
) -> TriageReport:
    """Pair every mismatch with its triage bucket, requiring full coverage."""
    mismatches = {(m.item_id, m.point_id): m for m in enumerate_mismatches(agreements)}
    bucket_by_key = {(c.item_id, c.point_id): c.bucket for c in corrections}

    untriaged = sorted(set(mismatches) - set(bucket_by_key))
    if untriaged:
        raise ValueError(
            f"untriaged mismatch(es) {untriaged}; ADR 0010 Decision 4 triages every "
            "judge↔human mismatch into a bucket"
        )

    triaged = tuple(
        TriagedMismatch(mismatch=mismatch, bucket=bucket_by_key[key])
        for key, mismatch in mismatches.items()
    )
    counts: dict[str, int] = {}
    for triaged_mismatch in triaged:
        counts[triaged_mismatch.bucket] = counts.get(triaged_mismatch.bucket, 0) + 1
    return TriageReport(triaged=triaged, bucket_counts=counts)


def triage_and_recompute(
    agreements: Sequence[PointAgreement],
    *,
    corrections: Sequence[Correction],
    seed: int,
    iterations: int = 2000,
    confidence: float = 0.95,
) -> RecomputeOnce:
    """Triage every mismatch, apply the corrections ONCE, and recompute κ ONCE.

    Returns κ before and after the single correction pass, the triage report (every
    mismatch with its bucket; raises on an untriaged mismatch or a correction that
    targets a non-mismatch), and the singly-corrected agreements. There is no
    target-κ argument and no loop: the published κ is the honest single-pass value,
    never a figure chased by re-correcting until it clears a bar (Decision 4).
    """
    report = _build_report(agreements, corrections)
    corrected = apply_corrections(agreements, corrections)
    before = compute_calibration(
        agreements, seed=seed, iterations=iterations, confidence=confidence
    )
    after = compute_calibration(corrected, seed=seed, iterations=iterations, confidence=confidence)
    return RecomputeOnce(
        before=before,
        after=after,
        report=report,
        corrected_agreements=corrected,
    )


__all__ = [
    "TriageBucket",
    "Mismatch",
    "Correction",
    "TriagedMismatch",
    "TriageReport",
    "RecomputeOnce",
    "enumerate_mismatches",
    "apply_corrections",
    "triage_and_recompute",
]
