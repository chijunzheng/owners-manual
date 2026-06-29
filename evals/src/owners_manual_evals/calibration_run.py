"""Calibration-run input producer (issue #19, ADR 0010 Decision 7).

``calibrate run`` is the small, targeted run that emits the THREE input files the
rest of the calibration pipeline consumes — ``answers.json``, ``claude.json``,
``gemini.json`` — INDEPENDENT of the four-arm matrix (Decision 7: calibration runs
early, on its own path, off the #21 disposition gate). The live model calls (the
agent arm + the Claude primary judge + the Gemini secondary judge) live in the thin
``# pragma: no cover`` CLI wiring; this module owns the PURE glue that shapes their
results into the committed JSON, fully unit-tested against the in-memory
:class:`~.run_naive_rag.ItemOutcome` / :class:`~.judge.JudgeResult` values.

The single CRITICAL correctness property: all three raters — Claude, Gemini, and the
human via the sheet — must grade the IDENTICAL agent-arm answer. ``answers.json`` is
that single source of answer text, fed to BOTH judges and to ``calibrate sheet``; the
two judge maps are keyed identically so :func:`calibration.require_verdict` can pair
them point-for-point. Both mappers are strict (the ``golden_item.py`` reject-don't-
coerce philosophy): a duplicate item id or an empty answer is a producer bug,
surfaced rather than silently dropped — a corrupted input would quietly skew κ.
"""

from __future__ import annotations

from collections.abc import Sequence

from .judge import JudgeResult
from .run_naive_rag import ItemOutcome


def answers_map_from_outcomes(outcomes: Sequence[ItemOutcome]) -> dict[str, str]:
    """Shape agent-arm outcomes into the ``answers.json`` ``{item_id: answer_text}``.

    This is the SINGLE source of answer text the run feeds to both judges and to
    ``calibrate sheet``, so all three raters grade the identical agent-arm answer
    (the run's critical correctness property). Strict: a duplicate item id (two
    outcomes for one item) or an empty/whitespace answer (the agent produced nothing
    to grade) raises rather than silently overwriting or writing a blank — either
    would corrupt the shared answer text. Never mutates its input.
    """
    answers: dict[str, str] = {}
    for outcome in outcomes:
        if outcome.item_id in answers:
            raise ValueError(
                f"duplicate item id {outcome.item_id!r} among agent outcomes; the "
                "calibration run produces exactly one answer per slice item"
            )
        if not outcome.answer_text.strip():
            raise ValueError(
                f"agent outcome for {outcome.item_id!r} carries an empty answer; the "
                "calibration run cannot grade a blank answer (fail loud, never blank)"
            )
        answers[outcome.item_id] = outcome.answer_text
    return answers


def verdict_map_from_judge_results(results: Sequence[JudgeResult]) -> dict[str, dict[str, bool]]:
    """Shape judge results into the ``{item_id: {point_id: bool}}`` verdict map.

    The committed ``claude.json`` / ``gemini.json`` shape :func:`calibration.
    require_verdict` reads back: per item, a point id → a JSON boolean credit. The
    values are real :class:`bool`\\ s (``JudgePointVerdict.credited``), so the
    round-trip through JSON stays honest — ``require_verdict`` rejects a coerced
    non-bool. Strict: a duplicate item id raises rather than silently overwriting one
    item's verdicts with another's. Never mutates its input.
    """
    verdicts: dict[str, dict[str, bool]] = {}
    for result in results:
        if result.item_id in verdicts:
            raise ValueError(
                f"duplicate item id {result.item_id!r} among judge results; the "
                "calibration run judges each slice item exactly once"
            )
        verdicts[result.item_id] = {
            verdict.point_id: bool(verdict.credited) for verdict in result.point_verdicts
        }
    return verdicts


__all__ = ["answers_map_from_outcomes", "verdict_map_from_judge_results"]
