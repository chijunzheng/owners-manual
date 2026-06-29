"""Strict corrections-file parser tests (issue #19, ADR 0010 Decision 4).

``calibrate triage`` reads a ``corrections.yaml`` that triages every judge↔human
mismatch into a bucket and, for a relabel bucket, the corrected human credit. The
parser mirrors ``parse_labels`` / ``parse_slice_manifest`` (the ``golden_item.py``
reject-don't-coerce philosophy) and enforces the HONEST-DEFAULT discipline of
Decision 4 at load time:

* unknown top-level or per-row keys are rejected (never coerced);
* ``bucket`` must be one of the three triage buckets;
* ``justification`` is REQUIRED, non-empty, for EVERY correction — the written-
  justification discipline (a relabel without a stated reason is rejected);
* ``corrected_human_credited`` is REQUIRED (a bool) for the relabel buckets
  (``rubric-wrong`` / ``human-error``) and FORBIDDEN for ``judge-error`` (which never
  relabels — mirroring :func:`calibration_triage._validate_correction`).

The parser yields :class:`calibration_triage.Correction` objects, so the parsed
output drops straight into :func:`calibration_triage.triage_and_recompute`.
"""

from __future__ import annotations

import pytest
import yaml

from owners_manual_evals.calibration_corrections import parse_corrections
from owners_manual_evals.calibration_triage import Correction


def _doc(*rows: dict[str, object]) -> str:
    return yaml.safe_dump({"corrections": list(rows)})


def _row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "item_id": "answer-1",
        "point_id": "duty",
        "bucket": "human-error",
        "justification": "I misread the answer; it does assert the duty.",
        "corrected_human_credited": True,
    }
    row.update(overrides)
    return row


# --- the happy path → Correction objects -----------------------------------


def test_parses_a_relabel_correction_into_a_correction_object() -> None:
    parsed = parse_corrections(_doc(_row()))
    assert parsed == (
        Correction(
            item_id="answer-1",
            point_id="duty",
            bucket="human-error",
            corrected_human_credited=True,
        ),
    )


def test_parses_a_judge_error_correction_without_a_relabel() -> None:
    parsed = parse_corrections(
        _doc(
            {
                "item_id": "answer-1",
                "point_id": "duty",
                "bucket": "judge-error",
                "justification": "The judge credited a point the answer never makes.",
            }
        )
    )
    assert parsed == (Correction(item_id="answer-1", point_id="duty", bucket="judge-error"),)


def test_parses_a_rubric_wrong_correction_with_its_relabel() -> None:
    parsed = parse_corrections(_doc(_row(bucket="rubric-wrong", corrected_human_credited=False)))
    assert parsed[0].bucket == "rubric-wrong"
    assert parsed[0].corrected_human_credited is False


# --- the written-justification discipline (Decision 4 / the build's decision 5) ---


def test_missing_justification_is_rejected() -> None:
    row = _row()
    del row["justification"]
    with pytest.raises(ValueError, match="justification"):
        parse_corrections(_doc(row))


def test_empty_justification_is_rejected() -> None:
    # A blank reason is not a justification — the relabel discipline requires a
    # WRITTEN reason for every correction, judge-error included.
    with pytest.raises(ValueError, match="justification"):
        parse_corrections(_doc(_row(justification="   ")))


def test_judge_error_also_requires_a_justification() -> None:
    with pytest.raises(ValueError, match="justification"):
        parse_corrections(_doc({"item_id": "a", "point_id": "p", "bucket": "judge-error"}))


# --- the relabel ⇄ bucket coupling (mirrors _validate_correction) ----------


def test_relabel_bucket_requires_corrected_human_credited() -> None:
    row = _row()
    del row["corrected_human_credited"]
    with pytest.raises(ValueError, match="corrected_human_credited|human-error"):
        parse_corrections(_doc(row))


def test_judge_error_forbids_corrected_human_credited() -> None:
    # A judge-error never relabels (Decision 4); smuggling a corrected value is
    # rejected so the judge's frozen verdict can never be flipped via the file.
    with pytest.raises(ValueError, match="judge-error|corrected_human_credited"):
        parse_corrections(
            _doc(
                {
                    "item_id": "a",
                    "point_id": "p",
                    "bucket": "judge-error",
                    "justification": "the judge is wrong",
                    "corrected_human_credited": True,
                }
            )
        )


def test_corrected_human_credited_must_be_a_bool() -> None:
    # "yes" is not a boolean relabel — reject rather than coerce (golden_item.py).
    with pytest.raises(ValueError, match="corrected_human_credited|bool"):
        parse_corrections(_doc(_row(corrected_human_credited="yes")))


# --- the strict shape (reject-don't-coerce) --------------------------------


def test_unknown_bucket_is_rejected() -> None:
    with pytest.raises(ValueError, match="bucket"):
        parse_corrections(_doc(_row(bucket="not-a-bucket")))


def test_unknown_row_key_is_rejected() -> None:
    with pytest.raises(ValueError, match="unknown"):
        parse_corrections(_doc(_row(notes="should not be here")))


def test_unknown_top_level_key_is_rejected() -> None:
    text = yaml.safe_dump({"corrections": [_row()], "extra": 1})
    with pytest.raises(ValueError, match="unknown"):
        parse_corrections(text)


def test_missing_item_or_point_id_is_rejected() -> None:
    row = _row()
    del row["item_id"]
    with pytest.raises(ValueError, match="item_id"):
        parse_corrections(_doc(row))


def test_non_mapping_document_is_rejected() -> None:
    with pytest.raises(ValueError, match="mapping"):
        parse_corrections("- just\n- a\n- list\n")


def test_empty_corrections_list_is_allowed() -> None:
    # A run with zero mismatches has zero corrections — an empty (but present)
    # corrections list parses to an empty tuple, not an error (it is a valid triage).
    assert parse_corrections(yaml.safe_dump({"corrections": []})) == ()
