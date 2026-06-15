"""Join judge verdicts to the exact traces they judged (issue #18 AC4).

The judge runs OFFLINE over the produced answers, but its verdicts must land on
the SAME Langfuse traces the answers came from — so the dashboard can read the
deterministic metrics and the judge's point score side by side on one trace. This
module writes a :class:`JudgeResult` through the SAME ``ScoreSink`` seam the
deterministic metrics use (``run_naive_rag.ScoreSink`` / ``build_score_sink``),
keyed by the propagated trace id:

* ``judge_point_score`` — the fraction of rubric points credited (the published
  point score);
* ``judge_all_points_credited`` — 1.0 iff every point was credited (the judge's
  half of strict pass);
* ``judge_point:<id>`` — the binary verdict for each rubric point.

A verdict with no trace id to join to is dropped, not mis-joined — an orphan judge
score on the wrong trace is worse than a missing one.
"""

from __future__ import annotations

from collections.abc import Callable

from .judge import JudgeResult

#: The same kwargs-only score-sink signature the deterministic runner uses.
ScoreSink = Callable[..., None]


def write_judge_scores(
    result: JudgeResult,
    *,
    trace_id: str | None,
    score_sink: ScoreSink,
) -> None:
    """Write one item's judge verdicts to the score sink, joined by trace id.

    No-ops when ``trace_id`` is ``None`` (nothing to join to)."""
    if trace_id is None:
        return
    score_sink(trace_id=trace_id, name="judge_point_score", value=result.point_score)
    score_sink(
        trace_id=trace_id,
        name="judge_all_points_credited",
        value=1.0 if result.all_points_credited else 0.0,
    )
    for verdict in result.point_verdicts:
        score_sink(
            trace_id=trace_id,
            name=f"judge_point:{verdict.point_id}",
            value=1.0 if verdict.credited else 0.0,
        )


__all__ = ["ScoreSink", "write_judge_scores"]
