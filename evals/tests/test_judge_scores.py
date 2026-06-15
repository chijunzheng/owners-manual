"""Judge-verdict → Langfuse-score wiring tests (issue #18 AC4).

Judge verdicts are logged as Langfuse scores joined to the EXACT trace they
judged — threaded through the SAME ``ScoreSink`` seam the deterministic metrics
use, keyed by the propagated trace id. These tests use a fake sink that captures
what would be written; no Langfuse server is touched.
"""

from __future__ import annotations

from owners_manual_evals.judge import JudgePointVerdict, JudgeResult
from owners_manual_evals.judge_scores import write_judge_scores


def _result() -> JudgeResult:
    return JudgeResult(
        item_id="answer-1",
        point_verdicts=(
            JudgePointVerdict(point_id="duty", credited=True, rationale="ok"),
            JudgePointVerdict(point_id="covers-unit", credited=False, rationale="absent"),
        ),
        point_score=0.5,
        all_points_credited=False,
    )


def test_writes_point_score_joined_to_the_exact_trace() -> None:
    captured: list[dict] = []

    def sink(**kwargs: object) -> None:
        captured.append(dict(kwargs))

    write_judge_scores(_result(), trace_id="a" * 32, score_sink=sink)

    point_score = [c for c in captured if c["name"] == "judge_point_score"]
    assert len(point_score) == 1
    assert point_score[0]["trace_id"] == "a" * 32
    assert point_score[0]["value"] == 0.5


def test_writes_a_binary_score_per_rubric_point_on_the_same_trace() -> None:
    captured: list[dict] = []

    def sink(**kwargs: object) -> None:
        captured.append(dict(kwargs))

    write_judge_scores(_result(), trace_id="b" * 32, score_sink=sink)

    per_point = {c["name"]: c["value"] for c in captured if c["name"].startswith("judge_point:")}
    assert per_point == {"judge_point:duty": 1.0, "judge_point:covers-unit": 0.0}
    assert all(c["trace_id"] == "b" * 32 for c in captured)


def test_writes_all_points_credited_as_the_judge_half_of_strict_pass() -> None:
    captured: list[dict] = []

    def sink(**kwargs: object) -> None:
        captured.append(dict(kwargs))

    write_judge_scores(_result(), trace_id="c" * 32, score_sink=sink)
    credited = [c for c in captured if c["name"] == "judge_all_points_credited"]
    assert credited[0]["value"] == 0.0  # not all credited


def test_skips_when_no_trace_id_to_join_to() -> None:
    captured: list[dict] = []

    def sink(**kwargs: object) -> None:
        captured.append(dict(kwargs))

    write_judge_scores(_result(), trace_id=None, score_sink=sink)
    # With no trace to join to, nothing is written (a judge score with no trace is
    # an orphan — better dropped than mis-joined).
    assert captured == []
