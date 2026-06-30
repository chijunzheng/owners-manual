"""Calibration-run input-producer tests (issue #19, ADR 0010 Decision 7).

``calibrate run`` is the small targeted run that produces the THREE input files the
rest of the calibration pipeline consumes — independent of the four-arm matrix
(Decision 7 runs calibration early, off the disposition gate). The live model calls
(the agent arm + both judges) are ``# pragma: no cover``; the PURE glue that shapes
their results into the committed JSON is what these pin:

* :func:`answers_map_from_outcomes` — agent :class:`ItemOutcome`s → ``answers.json``
  ``{item_id: answer_text}``, the SINGLE source of answer text fed to both judges and
  to ``calibrate sheet`` (so all three raters grade the IDENTICAL agent-arm answer —
  the run's critical correctness property);
* :func:`verdict_map_from_judge_results` — a sequence of :class:`JudgeResult` →
  ``{item_id: {point_id: bool}}``, the ``claude.json`` / ``gemini.json`` shape
  :func:`calibration.require_verdict` reads back.

Both are strict (reject-don't-coerce, the ``golden_item.py`` philosophy): a duplicate
item id or an empty answer is a producer bug, surfaced rather than silently dropped —
a corrupted input file would quietly skew κ and prevalence.
"""

from __future__ import annotations

import pytest

from owners_manual_evals.calibration_run import (
    answers_map_from_outcomes,
    verdict_map_from_judge_results,
)
from owners_manual_evals.judge import JudgePointVerdict, JudgeResult
from owners_manual_evals.run_naive_rag import ItemOutcome


def _outcome(item_id: str, answer_text: str) -> ItemOutcome:
    return ItemOutcome(
        item_id=item_id,
        observed_behavior="answer",
        candidate_cites=(),
        retrieved_path_keys=(),
        latency_ms={},
        cost_usd=0.0,
        trace_id=f"trace-{item_id}",
        answer_text=answer_text,
    )


def _result(item_id: str, credited_by_point: dict[str, bool]) -> JudgeResult:
    verdicts = tuple(
        JudgePointVerdict(point_id=pid, credited=value) for pid, value in credited_by_point.items()
    )
    credited = sum(1 for v in verdicts if v.credited)
    return JudgeResult(
        item_id=item_id,
        point_verdicts=verdicts,
        point_score=credited / len(verdicts) if verdicts else 0.0,
        all_points_credited=credited == len(verdicts) and len(verdicts) > 0,
    )


# --- answers.json (the single source of answer text) -----------------------


def test_answers_map_keys_item_id_to_answer_text() -> None:
    outcomes = (
        _outcome("answer-1", "The landlord keeps the unit in repair."),
        _outcome("refuse-7", "I can't advise on that; consult the LTB."),
    )
    answers = answers_map_from_outcomes(outcomes)
    assert answers == {
        "answer-1": "The landlord keeps the unit in repair.",
        "refuse-7": "I can't advise on that; consult the LTB.",
    }


def test_answers_map_rejects_a_duplicate_item_id() -> None:
    # Two outcomes for one item would silently overwrite — a producer bug that
    # would feed two raters different answers for the same id. Surface it.
    outcomes = (_outcome("answer-1", "first"), _outcome("answer-1", "second"))
    with pytest.raises(ValueError, match="duplicate"):
        answers_map_from_outcomes(outcomes)


def test_answers_map_rejects_an_empty_answer_text() -> None:
    # An empty answer means the agent arm produced nothing for that item; grading a
    # blank answer is meaningless, so fail loud rather than write an empty string.
    with pytest.raises(ValueError, match="empty|answer"):
        answers_map_from_outcomes((_outcome("answer-1", "   "),))


# --- claude.json / gemini.json (the verdict map) ---------------------------


def test_verdict_map_keys_item_then_point_to_bool() -> None:
    results = (
        _result("answer-1", {"duty": True, "covers-unit": False}),
        _result("refuse-7", {"jurisdiction": True}),
    )
    verdicts = verdict_map_from_judge_results(results)
    assert verdicts == {
        "answer-1": {"duty": True, "covers-unit": False},
        "refuse-7": {"jurisdiction": True},
    }


def test_verdict_map_values_are_python_bools_not_truthy() -> None:
    # require_verdict rejects non-bools (a "false" string coerces to True). The map
    # must therefore carry real bools so the round-trip through JSON stays honest.
    verdicts = verdict_map_from_judge_results((_result("answer-1", {"duty": False}),))
    assert verdicts["answer-1"]["duty"] is False
    assert isinstance(verdicts["answer-1"]["duty"], bool)


def test_verdict_map_rejects_a_duplicate_item_id() -> None:
    results = (
        _result("answer-1", {"duty": True}),
        _result("answer-1", {"duty": False}),
    )
    with pytest.raises(ValueError, match="duplicate"):
        verdict_map_from_judge_results(results)
