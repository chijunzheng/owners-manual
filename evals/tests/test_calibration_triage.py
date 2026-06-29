"""Disagreement-triage + recompute-once tests (issue #19, ADR 0010 Decision 4).

ADR 0010 Decision 4: every judge↔human mismatch is triaged into one of three
buckets — ``rubric-wrong`` (ambiguous point → edit the golden item on dev),
``human-error`` (relabel), ``judge-error`` (counts against the judge). The
corrections (rubric-wrong + human-error) are applied **once**, κ is recomputed
**once**, and that is published — never iterated rubric→recompute until κ clears a
bar (that overfits the instrument to its own validation set; the rejected
"iterate until κ clears" alternative).

These pin the mechanics — never LLM quality:

* every mismatch surfaces in the triage report;
* the driver applies corrections once and recomputes once (no iterate-to-target);
* judge-error corrections never flip the judge's verdict — the judge always stands.
"""

from __future__ import annotations

import pytest

from owners_manual_evals.calibration import PointAgreement, compute_calibration
from owners_manual_evals.calibration_triage import (
    Correction,
    apply_corrections,
    enumerate_mismatches,
    triage_and_recompute,
)
from owners_manual_evals.disposition import DISPOSITIONS


def _agreement(
    point_id: str,
    *,
    human: bool,
    judge: bool,
    behavior_class: str = "answer",
) -> PointAgreement:
    return PointAgreement(
        item_id=f"item-{point_id}",
        point_id=point_id,
        behavior_class=behavior_class,
        human_credited=human,
        judge_credited=judge,
    )


# --- shared vocabulary with the disposition domain -------------------------


def test_rubric_wrong_shares_the_disposition_vocabulary() -> None:
    # The triage bucket and the disposition verdict mean the same thing (Decision 4
    # / Decision 7): a rubric-wrong finding is the golden set's own bug.
    assert "rubric-wrong" in DISPOSITIONS


# --- enumerating mismatches ------------------------------------------------


def test_every_mismatch_is_enumerated() -> None:
    agreements = (
        _agreement("agree-yes", human=True, judge=True),
        _agreement("miss-1", human=True, judge=False),
        _agreement("agree-no", human=False, judge=False),
        _agreement("miss-2", human=False, judge=True),
    )
    mismatches = enumerate_mismatches(agreements)
    assert {m.point_id for m in mismatches} == {"miss-1", "miss-2"}


def test_every_mismatch_surfaces_in_the_triage_report() -> None:
    agreements = (
        _agreement("miss-1", human=True, judge=False),
        _agreement("miss-2", human=False, judge=True),
        _agreement("agree", human=True, judge=True),
    )
    corrections = (
        Correction(
            item_id="item-miss-1",
            point_id="miss-1",
            bucket="human-error",
            corrected_human_credited=False,
        ),
        Correction(item_id="item-miss-2", point_id="miss-2", bucket="judge-error"),
    )
    result = triage_and_recompute(agreements, corrections=corrections, seed=1, iterations=200)
    triaged = {(t.mismatch.point_id, t.bucket) for t in result.report.triaged}
    assert triaged == {("miss-1", "human-error"), ("miss-2", "judge-error")}


def test_an_untriaged_mismatch_is_rejected() -> None:
    # Decision 4 triages EVERY mismatch — leaving one unlabeled is an error, not a
    # silent skip (the strict-parser philosophy).
    agreements = (
        _agreement("miss-1", human=True, judge=False),
        _agreement("miss-2", human=False, judge=True),
    )
    only_one = (Correction(item_id="item-miss-1", point_id="miss-1", bucket="judge-error"),)
    with pytest.raises(ValueError, match="untriaged|every mismatch"):
        triage_and_recompute(agreements, corrections=only_one, seed=1, iterations=50)


# --- applying corrections (immutable) --------------------------------------


def test_human_error_correction_relabels_the_human_side_only() -> None:
    agreements = (_agreement("miss-1", human=True, judge=False),)
    corrections = (
        Correction(
            item_id="item-miss-1",
            point_id="miss-1",
            bucket="human-error",
            corrected_human_credited=False,
        ),
    )
    corrected = apply_corrections(agreements, corrections)
    assert corrected[0].human_credited is False  # relabeled
    assert corrected[0].judge_credited is False  # judge untouched
    # The input is never mutated (frozen value semantics).
    assert agreements[0].human_credited is True


def test_judge_error_correction_does_not_flip_the_judge_verdict() -> None:
    # The judge is wrong here (credits a point the human does not); triaged
    # judge-error, the judge's verdict STANDS and the mismatch counts against it.
    agreements = (_agreement("miss-1", human=False, judge=True),)
    corrections = (Correction(item_id="item-miss-1", point_id="miss-1", bucket="judge-error"),)
    corrected = apply_corrections(agreements, corrections)
    assert corrected[0].judge_credited is True  # NOT flipped
    assert corrected[0].human_credited is False  # human stands too
    # Still a mismatch after "correction" — it is counted against the judge.
    assert enumerate_mismatches(corrected)


def test_judge_error_correction_may_not_carry_a_relabel() -> None:
    # A judge-error never relabels (that is its meaning); smuggling a corrected
    # human value is rejected so the judge can never be silently flipped via it.
    with pytest.raises(ValueError, match="judge-error"):
        apply_corrections(
            (_agreement("miss-1", human=False, judge=True),),
            (
                Correction(
                    item_id="item-miss-1",
                    point_id="miss-1",
                    bucket="judge-error",
                    corrected_human_credited=True,
                ),
            ),
        )


def test_rubric_wrong_relabel_needs_a_corrected_value() -> None:
    with pytest.raises(ValueError, match="rubric-wrong|corrected"):
        apply_corrections(
            (_agreement("miss-1", human=True, judge=False),),
            (Correction(item_id="item-miss-1", point_id="miss-1", bucket="rubric-wrong"),),
        )


def test_correction_targeting_a_non_mismatch_is_rejected() -> None:
    # Corrections triage MISMATCHES; pointing one at an agreeing point is a caller
    # bug, surfaced rather than silently ignored.
    agreements = (_agreement("agree", human=True, judge=True),)
    corrections = (
        Correction(
            item_id="item-agree",
            point_id="agree",
            bucket="human-error",
            corrected_human_credited=False,
        ),
    )
    with pytest.raises(ValueError, match="mismatch"):
        apply_corrections(agreements, corrections)


# --- recompute exactly once (no iterate-to-target) -------------------------


def test_driver_applies_corrections_once_and_recomputes_once() -> None:
    agreements = (
        _agreement("m1", human=True, judge=False),
        _agreement("m2", human=False, judge=True),
        _agreement("ok1", human=True, judge=True),
        _agreement("ok2", human=False, judge=False),
        _agreement("ok3", human=True, judge=True),
    )
    corrections = (
        Correction(
            item_id="item-m1", point_id="m1", bucket="human-error", corrected_human_credited=False
        ),
        Correction(
            item_id="item-m2", point_id="m2", bucket="rubric-wrong", corrected_human_credited=True
        ),
    )
    result = triage_and_recompute(agreements, corrections=corrections, seed=3, iterations=200)

    # `before` is one κ over the raw data; `after` is one κ over the SINGLY-corrected
    # data — exactly what an independent single application yields (applied once).
    expected_after = compute_calibration(
        apply_corrections(agreements, corrections), seed=3, iterations=200
    )
    expected_before = compute_calibration(agreements, seed=3, iterations=200)
    assert result.after.kappa == pytest.approx(expected_after.kappa)
    assert result.before.kappa == pytest.approx(expected_before.kappa)
    assert result.corrected_agreements == apply_corrections(agreements, corrections)


def test_driver_does_not_chase_a_target_kappa() -> None:
    # Only m1 is corrected; m2 is a judge-error that STAYS a mismatch. The driver
    # publishes whatever the single pass yields — it does not keep correcting to
    # reach a nicer κ (the rejected "iterate until κ clears" alternative).
    agreements = (
        _agreement("m1", human=True, judge=False),
        _agreement("m2", human=False, judge=True),
        _agreement("ok1", human=True, judge=True),
        _agreement("ok2", human=False, judge=False),
    )
    corrections = (
        Correction(
            item_id="item-m1", point_id="m1", bucket="human-error", corrected_human_credited=False
        ),
        Correction(item_id="item-m2", point_id="m2", bucket="judge-error"),
    )
    result = triage_and_recompute(agreements, corrections=corrections, seed=9, iterations=200)
    # The judge-error mismatch survives the recompute (counts against the judge).
    assert any(m.point_id == "m2" for m in enumerate_mismatches(result.corrected_agreements))
    # And the published κ is exactly the honest single-pass value, not a chased one.
    single_pass = compute_calibration(
        apply_corrections(agreements, corrections), seed=9, iterations=200
    )
    assert result.after.kappa == pytest.approx(single_pass.kappa)


def test_report_counts_each_bucket() -> None:
    agreements = (
        _agreement("m1", human=True, judge=False),
        _agreement("m2", human=False, judge=True),
        _agreement("m3", human=True, judge=False),
    )
    corrections = (
        Correction(
            item_id="item-m1", point_id="m1", bucket="human-error", corrected_human_credited=False
        ),
        Correction(item_id="item-m2", point_id="m2", bucket="judge-error"),
        Correction(
            item_id="item-m3", point_id="m3", bucket="rubric-wrong", corrected_human_credited=False
        ),
    )
    result = triage_and_recompute(agreements, corrections=corrections, seed=1, iterations=100)
    assert result.report.bucket_counts["human-error"] == 1
    assert result.report.bucket_counts["judge-error"] == 1
    assert result.report.bucket_counts["rubric-wrong"] == 1
