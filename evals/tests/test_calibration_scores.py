"""Calibration score-write tests (issue #19, ADR 0010 Decisions 1, 5, 6).

The derived κ/agreement land back in Langfuse (the sole system of record) and the
README; the human labels are the committed artifact. This pins the PURE score
wiring — threaded through the SAME injected ``ScoreSink`` seam the judge and the
deterministic metrics use (``judge_scores.py``), so the offline suite asserts
exactly what would be written with no Langfuse server:

* ``human_point:<id>`` — the human's per-point verdict, joined to the EXACT trace,
  so κ pairs it against the judge's ``judge_point:<id>`` (Decision 1);
* the run-level κ scores (three κ + agreement + prevalence + CI bounds);
* a SEPARATE calibration score-name + queue from the disposition domain — calibration
  runs off the disposition gate (Decision 7) and must not reuse its score name.
"""

from __future__ import annotations

from owners_manual_evals.bootstrap import ConfidenceInterval
from owners_manual_evals.calibration import CalibrationResult
from owners_manual_evals.calibration_report import JudgeJudgeKappa
from owners_manual_evals.calibration_scores import (
    CALIBRATION_KAPPA_CLAUDE_GEMINI,
    CALIBRATION_KAPPA_CLAUDE_HUMAN,
    CALIBRATION_KAPPA_GEMINI_HUMAN,
    CALIBRATION_QUEUE_ENV,
    HUMAN_POINT_SCORE_PREFIX,
    write_calibration_scores,
    write_human_point_scores,
)
from owners_manual_evals.disposition import DISPOSITION_SCORE_NAME


def _capture() -> tuple[list[dict], object]:
    captured: list[dict] = []

    def sink(**kwargs: object) -> None:
        captured.append(dict(kwargs))

    return captured, sink


def _result() -> CalibrationResult:
    return CalibrationResult(
        kappa=0.42,
        observed_agreement=0.70,
        positive_prevalence=0.55,
        negative_prevalence=0.45,
        kappa_ci=ConfidenceInterval(
            point_estimate=0.42, low=0.10, high=0.74, confidence=0.95, iterations=2000
        ),
        per_class_kappa={"answer": 1.0},
        n_decisions=60,
    )


# --- human_point:<id> (paired against judge_point:<id>) --------------------


def test_writes_a_human_point_score_per_point_joined_to_the_trace() -> None:
    captured, sink = _capture()
    write_human_point_scores(
        point_credits={"duty": True, "covers-unit": False},
        trace_id="a" * 32,
        score_sink=sink,
    )
    by_name = {c["name"]: c for c in captured}
    assert by_name["human_point:duty"]["value"] == 1.0
    assert by_name["human_point:covers-unit"]["value"] == 0.0
    assert all(c["trace_id"] == "a" * 32 for c in captured)


def test_human_point_prefix_mirrors_but_differs_from_the_judge_prefix() -> None:
    # κ pairs human_point:<id> ↔ judge_point:<id>: same per-point convention, a
    # distinct human_ prefix so the two streams never collide on a trace.
    assert HUMAN_POINT_SCORE_PREFIX == "human_point:"
    assert HUMAN_POINT_SCORE_PREFIX != "judge_point:"


def test_human_point_scores_no_op_without_a_trace() -> None:
    captured, sink = _capture()
    write_human_point_scores(point_credits={"duty": True}, trace_id=None, score_sink=sink)
    # A score with no trace to join to is an orphan — dropped, like judge_scores.
    assert captured == []


# --- the run-level κ scores ------------------------------------------------


def test_writes_the_three_run_level_kappas() -> None:
    captured, sink = _capture()
    judge_judge = JudgeJudgeKappa(claude_vs_human=0.42, gemini_vs_human=0.55, claude_vs_gemini=0.80)
    write_calibration_scores(
        primary=_result(), judge_judge=judge_judge, trace_id="r" * 32, score_sink=sink
    )
    by_name = {c["name"]: c["value"] for c in captured}
    assert by_name[CALIBRATION_KAPPA_CLAUDE_HUMAN] == 0.42
    assert by_name[CALIBRATION_KAPPA_GEMINI_HUMAN] == 0.55
    assert by_name[CALIBRATION_KAPPA_CLAUDE_GEMINI] == 0.80


def test_run_level_scores_carry_agreement_and_prevalence_beside_kappa() -> None:
    captured, sink = _capture()
    judge_judge = JudgeJudgeKappa(claude_vs_human=0.42, gemini_vs_human=0.55, claude_vs_gemini=0.80)
    write_calibration_scores(
        primary=_result(), judge_judge=judge_judge, trace_id="r" * 32, score_sink=sink
    )
    values = {c["value"] for c in captured}
    # κ never travels alone (ADR Decision 3): agreement + prevalence ship too.
    assert 0.70 in values  # observed agreement
    assert 0.55 in values  # positive prevalence


def test_run_level_scores_no_op_without_a_trace() -> None:
    captured, sink = _capture()
    judge_judge = JudgeJudgeKappa(claude_vs_human=0.42, gemini_vs_human=0.55, claude_vs_gemini=0.80)
    write_calibration_scores(
        primary=_result(), judge_judge=judge_judge, trace_id=None, score_sink=sink
    )
    assert captured == []


# --- the calibration domain is SEPARATE from the disposition domain --------


def test_calibration_score_names_never_reuse_the_disposition_score_name() -> None:
    names = {
        CALIBRATION_KAPPA_CLAUDE_HUMAN,
        CALIBRATION_KAPPA_GEMINI_HUMAN,
        CALIBRATION_KAPPA_CLAUDE_GEMINI,
    }
    assert DISPOSITION_SCORE_NAME not in names
    assert all(name != DISPOSITION_SCORE_NAME for name in names)


def test_calibration_queue_env_is_distinct_from_the_disposition_queue() -> None:
    # Calibration uses its OWN annotation queue (Decision 7: off the disposition gate).
    assert CALIBRATION_QUEUE_ENV != "LANGFUSE_DISPOSITION_QUEUE_ID"
    assert "CALIBRATION" in CALIBRATION_QUEUE_ENV
