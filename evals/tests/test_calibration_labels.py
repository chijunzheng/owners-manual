"""Blind labeling-sheet generator + strict loader tests (issue #19, ADR 0010 Decision 5).

The human labels are the #19 deliverable ("the human labels are the artifact").
ADR 0010 Decision 5 pins the sheet's shape: one row per (item, point) carrying the
question + the agent-arm answer + the point text + a BLANK ``human_credited`` — and
crucially **no judge verdict or rationale**. Blinding is load-bearing (Decision 5,
and the "show the judge's verdict for context" rejected alternative): if the human
sees the judge's verdict while labeling, κ measures suggestibility, not agreement.

These pin the generator's schema and the loader's strictness — never LLM quality:

* the generated row carries question + answer + point text, ``human_credited`` blank;
* **the blinding guard** — the generated sheet carries NO judge field anywhere
  (no ``judge``/``verdict``/``rationale``, no pre-filled ``credited``);
* the loader rejects a non-bool / unfilled ``human_credited`` and any unknown key
  (the strict-parser philosophy of ``golden_item.py``, doubling as blinding defense).
"""

from __future__ import annotations

import pytest
import yaml

from owners_manual_evals.calibration_labels import (
    LabelRow,
    build_labeling_sheet,
    parse_labels,
    render_labeling_sheet,
)
from owners_manual_evals.golden_item import parse_golden_item

#: Keys that would void the blind measurement if they reached the labeling sheet.
_FORBIDDEN_KEYS = {"judge", "credited", "verdict", "rationale"}


def _item(item_id: str = "answer-1") -> object:
    return parse_golden_item(
        {
            "id": item_id,
            "behavior_class": "answer",
            "corpus": "tenancy",
            "verified": True,
            "question": "Who repairs the unit?",
            "answer_points": [
                {"id": "duty", "text": "The landlord must keep the unit in repair."},
                {"id": "covers-unit", "text": "The duty covers the rental unit itself."},
            ],
            "required_cites": [],
            "provenance": {"source": "statute", "reference": "x"},
        },
        documents=(),
    )


# --- the generator ---------------------------------------------------------


def test_one_row_per_answer_point_carrying_question_answer_point_text() -> None:
    rows = build_labeling_sheet(
        _item(),
        answer_text="The landlord keeps the unit in repair, the unit included.",
    )
    assert len(rows) == 2
    by_point = {row.point_id: row for row in rows}
    assert by_point["duty"].question == "Who repairs the unit?"
    assert "landlord keeps the unit" in by_point["duty"].answer
    assert by_point["duty"].point_text == "The landlord must keep the unit in repair."
    assert by_point["covers-unit"].point_text == "The duty covers the rental unit itself."
    assert all(row.item_id == "answer-1" for row in rows)


def test_generated_human_credited_is_blank() -> None:
    rows = build_labeling_sheet(_item(), answer_text="anything")
    # The human fills it in BLIND; the generator leaves it unset (None).
    assert all(row.human_credited is None for row in rows)


# --- the blinding guard (ADR 0010 Decision 5) ------------------------------


def test_label_row_dataclass_carries_no_judge_field() -> None:
    fields = set(LabelRow.__dataclass_fields__)
    # human_credited is the ONLY credited-bearing field; no bare judge verdict.
    assert "human_credited" in fields
    assert fields.isdisjoint(_FORBIDDEN_KEYS)
    assert all("judge" not in name for name in fields)


def test_rendered_sheet_contains_no_judge_field_anywhere() -> None:
    rows = build_labeling_sheet(_item(), answer_text="the produced answer text")
    rendered = render_labeling_sheet(rows)
    parsed = yaml.safe_load(rendered)
    entries = parsed["labels"] if isinstance(parsed, dict) else parsed

    for entry in entries:
        keys = set(entry)
        # No judge verdict, rationale, or pre-filled credited may ride along.
        assert keys.isdisjoint(_FORBIDDEN_KEYS), keys
        assert all("judge" not in key for key in keys), keys
        # And the human field is present but blank in the emitted sheet.
        assert entry["human_credited"] is None


def test_rendered_sheet_shows_the_answer_for_grading_but_never_a_verdict() -> None:
    rows = build_labeling_sheet(_item(), answer_text="UNIQUE-ANSWER-TOKEN repair duty")
    rendered = render_labeling_sheet(rows)
    # The answer text is shown (the human grades against it)…
    assert "UNIQUE-ANSWER-TOKEN" in rendered
    # …but no judge verdict vocabulary leaks into the blind sheet.
    lowered = rendered.lower()
    assert "verdict" not in lowered
    assert "rationale" not in lowered


# --- the strict loader -----------------------------------------------------


def _filled_sheet(human_credited: object = True, **extra: object) -> str:
    entry = {
        "item_id": "answer-1",
        "point_id": "duty",
        "question": "Who repairs the unit?",
        "answer": "The landlord keeps the unit in repair.",
        "point_text": "The landlord must keep the unit in repair.",
        "human_credited": human_credited,
        **extra,
    }
    return yaml.safe_dump({"labels": [entry]})


def test_loader_parses_a_filled_sheet_into_bool_decisions() -> None:
    rows = parse_labels(_filled_sheet(human_credited=True))
    assert len(rows) == 1
    assert rows[0].item_id == "answer-1"
    assert rows[0].point_id == "duty"
    assert rows[0].human_credited is True


def test_loader_rejects_a_non_bool_human_credited() -> None:
    # "yes" is not a boolean decision — reject rather than coerce (golden_item.py).
    with pytest.raises(ValueError, match="human_credited"):
        parse_labels(_filled_sheet(human_credited="yes"))


def test_loader_rejects_an_unfilled_human_credited() -> None:
    # A blank (null) row means the human did not grade that point — the filled
    # sheet must decide every point, so an unfilled row is rejected, not skipped.
    with pytest.raises(ValueError, match="human_credited"):
        parse_labels(_filled_sheet(human_credited=None))


def test_loader_rejects_a_smuggled_judge_key() -> None:
    # Defense-in-depth blinding: a judge verdict pasted into the filled sheet is an
    # unknown key and is rejected, so a leaked verdict can never enter the κ inputs.
    with pytest.raises(ValueError, match="unknown"):
        parse_labels(_filled_sheet(judge="credited"))
