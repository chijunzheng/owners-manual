"""Calibration → Langfuse score wiring, pure side (issue #19, ADR 0010 Decisions 1, 6).

The derived κ/agreement land back in Langfuse (the sole system of record) and the
README; the committed human labels are the artifact. This module owns the PURE
score wiring, threaded through the SAME injected ``ScoreSink`` seam the judge and
the deterministic metrics use (:mod:`judge_scores`), so the offline suite asserts
exactly what would be written with no Langfuse server. The live binding (the real
Langfuse client + the separate calibration annotation queue) is the thin
``# pragma: no cover`` :mod:`calibration_live` module.

Two writers:

* :func:`write_human_point_scores` — the human's ``human_point:<id>`` per point,
  joined to the EXACT agent-arm trace, so κ pairs it against ``judge_point:<id>``
  (ADR 0010 Decision 1). Mirrors :func:`judge_scores.write_judge_scores`, including
  the orphan rule (no trace ⇒ dropped, never mis-joined);
* :func:`write_calibration_scores` — the run-level κ figures (the three κ +
  observed agreement + prevalence + CI bounds), under calibration-OWN score names.

The calibration score names and annotation queue are DELIBERATELY distinct from the
:mod:`disposition` domain's: calibration runs early, off the disposition gate
(Decision 7), and must never reuse the ``disposition`` score name or queue.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping

from .calibration import CalibrationResult
from .calibration_report import JudgeJudgeKappa

#: The same kwargs-only score-sink signature the judge/deterministic runner uses.
ScoreSink = Callable[..., None]

#: The per-point human verdict score-name prefix. Mirrors the judge's
#: ``judge_point:<id>`` convention with a distinct ``human_`` prefix, so κ pairs the
#: two streams on a trace without collision (ADR 0010 Decision 1).
HUMAN_POINT_SCORE_PREFIX = "human_point:"

#: The run-level κ score names — calibration's OWN, never the disposition score name.
CALIBRATION_KAPPA_CLAUDE_HUMAN = "calibration_kappa_claude_human"
CALIBRATION_KAPPA_GEMINI_HUMAN = "calibration_kappa_gemini_human"
CALIBRATION_KAPPA_CLAUDE_GEMINI = "calibration_kappa_claude_gemini"
CALIBRATION_OBSERVED_AGREEMENT = "calibration_observed_agreement"
CALIBRATION_POSITIVE_PREVALENCE = "calibration_positive_prevalence"
CALIBRATION_KAPPA_CI_LOW = "calibration_kappa_ci_low"
CALIBRATION_KAPPA_CI_HIGH = "calibration_kappa_ci_high"

#: Every run-level calibration score name, for a guard test / the live reader.
CALIBRATION_SCORE_NAMES: tuple[str, ...] = (
    CALIBRATION_KAPPA_CLAUDE_HUMAN,
    CALIBRATION_KAPPA_GEMINI_HUMAN,
    CALIBRATION_KAPPA_CLAUDE_GEMINI,
    CALIBRATION_OBSERVED_AGREEMENT,
    CALIBRATION_POSITIVE_PREVALENCE,
    CALIBRATION_KAPPA_CI_LOW,
    CALIBRATION_KAPPA_CI_HIGH,
)

#: The calibration annotation-queue env var — its OWN queue, distinct from the
#: disposition queue (``LANGFUSE_DISPOSITION_QUEUE_ID``); Decision 7 runs calibration
#: off the disposition pre-flight gate.
CALIBRATION_QUEUE_ENV = "LANGFUSE_CALIBRATION_QUEUE_ID"


def write_human_point_scores(
    *,
    point_credits: Mapping[str, bool],
    trace_id: str | None,
    score_sink: ScoreSink,
) -> None:
    """Write the human's ``human_point:<id>`` per-point verdicts, joined by trace id.

    No-ops when ``trace_id`` is ``None`` — a human-point score with no trace to join
    to is an orphan, dropped rather than mis-joined (the :mod:`judge_scores` rule).
    """
    if trace_id is None:
        return
    for point_id, credited in point_credits.items():
        score_sink(
            trace_id=trace_id,
            name=f"{HUMAN_POINT_SCORE_PREFIX}{point_id}",
            value=1.0 if credited else 0.0,
        )


def write_calibration_scores(
    *,
    primary: CalibrationResult,
    judge_judge: JudgeJudgeKappa,
    trace_id: str | None,
    score_sink: ScoreSink,
) -> None:
    """Write the run-level calibration figures to the calibration run trace.

    The three κ (ADR 0010 Decision 6) plus — because κ never travels alone (Decision
    3) — observed agreement, positive prevalence, and the bootstrap CI bounds. The
    Claude↔human κ is the primary trust label; the two Gemini κ are diagnostic.
    No-ops when ``trace_id`` is ``None``.
    """
    if trace_id is None:
        return
    figures = {
        CALIBRATION_KAPPA_CLAUDE_HUMAN: primary.kappa,
        CALIBRATION_KAPPA_GEMINI_HUMAN: judge_judge.gemini_vs_human,
        CALIBRATION_KAPPA_CLAUDE_GEMINI: judge_judge.claude_vs_gemini,
        CALIBRATION_OBSERVED_AGREEMENT: primary.observed_agreement,
        CALIBRATION_POSITIVE_PREVALENCE: primary.positive_prevalence,
        CALIBRATION_KAPPA_CI_LOW: primary.kappa_ci.low,
        CALIBRATION_KAPPA_CI_HIGH: primary.kappa_ci.high,
    }
    for name, value in figures.items():
        score_sink(trace_id=trace_id, name=name, value=value)


__all__ = [
    "ScoreSink",
    "HUMAN_POINT_SCORE_PREFIX",
    "CALIBRATION_KAPPA_CLAUDE_HUMAN",
    "CALIBRATION_KAPPA_GEMINI_HUMAN",
    "CALIBRATION_KAPPA_CLAUDE_GEMINI",
    "CALIBRATION_OBSERVED_AGREEMENT",
    "CALIBRATION_POSITIVE_PREVALENCE",
    "CALIBRATION_KAPPA_CI_LOW",
    "CALIBRATION_KAPPA_CI_HIGH",
    "CALIBRATION_SCORE_NAMES",
    "CALIBRATION_QUEUE_ENV",
    "write_human_point_scores",
    "write_calibration_scores",
]
