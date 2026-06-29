"""Live Langfuse wiring for judge calibration (issue #19, ADR 0010 Decisions 5–7).

The thin, LIVE-by-design binding behind the pure calibration modules — wrapped
around the SAME seams the offline suite drives (:mod:`calibration_scores`'s
``ScoreSink``, :mod:`annotation_queue`'s ``AnnotationQueueSink``, and
:func:`live_runner.build_score_sink`), in the spirit of :mod:`live_annotation_queue`,
so the unit suite needs no SDK and no server. Everything here is ``# pragma: no
cover``; the pure logic it feeds is fully tested against fakes.

The bindings:

* :func:`resolve_calibration_queue_id` — the calibration annotation-queue id from
  the environment (its OWN queue + env var, distinct from the disposition queue:
  Decision 7 runs calibration off the disposition gate);
* :func:`build_calibration_queue_sink` — enqueue each slice item's agent-arm TRACE
  onto the calibration queue for BLIND human labeling (Decision 5);
* :func:`write_calibration_back` — write the human ``human_point:<id>`` verdicts
  (joined to each item's trace) and the run-level κ scores back to Langfuse
  (Decision 6), reusing the deterministic score sink.

Langfuse v4 exposes annotation queues on the lower-level API client
(``Langfuse.api.annotation_queues``); both are reached lazily so importing this
module never requires the SDK.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .annotation_queue import AnnotationQueueSink
from .calibration import CalibrationResult
from .calibration_report import JudgeJudgeKappa
from .calibration_scores import (
    CALIBRATION_QUEUE_ENV,
    write_calibration_scores,
    write_human_point_scores,
)

#: The Langfuse object type a calibration queue item points at — the harness trace
#: each agent-arm answer was produced on (so the human grades the right answer).
_TRACE_OBJECT_TYPE = "TRACE"


def resolve_calibration_queue_id() -> str:  # pragma: no cover - live wiring
    """The calibration annotation-queue id from the environment, or a clear error.

    Calibration uses its OWN queue (``LANGFUSE_CALIBRATION_QUEUE_ID``), never the
    disposition queue — Decision 7 runs calibration early, off the disposition gate.
    """
    import os  # noqa: PLC0415

    queue_id = os.environ.get(CALIBRATION_QUEUE_ENV) or ""
    if not queue_id:
        raise RuntimeError(
            f"{CALIBRATION_QUEUE_ENV} is not set. Create a SEPARATE calibration "
            "annotation queue in Langfuse (Annotate → Queues) and put its id in .env "
            "before running calibration (ADR 0010 Decision 7: off the disposition gate)."
        )
    return queue_id


def build_calibration_queue_sink(  # pragma: no cover - live wiring
    langfuse: Any,
    *,
    queue_id: str,
) -> AnnotationQueueSink:
    """An annotation-queue sink that enqueues each slice item's trace for labeling.

    Mirrors :func:`live_annotation_queue.build_queue_sink`: the pure enqueue loop
    calls this once per slice item with the agent-arm trace (``object_id``), so the
    human grades that exact answer blind."""

    def sink(*, object_id: str, object_type: str, item_id: str) -> None:
        _ = item_id  # legibility only; the queue item is keyed by the trace id
        langfuse.api.annotation_queues.create_queue_item(
            queue_id,
            object_id=object_id,
            object_type=object_type,
        )

    return sink


def write_calibration_back(  # pragma: no cover - live wiring
    langfuse: Any,
    *,
    point_credits_by_trace: Mapping[str, Mapping[str, bool]],
    primary: CalibrationResult,
    judge_judge: JudgeJudgeKappa,
    run_trace_id: str,
) -> None:
    """Write the human verdicts + run-level κ back to Langfuse, reusing the seams.

    For each agent-arm trace, the human's ``human_point:<id>`` verdicts (from the
    committed labels) land joined to that trace; the run-level κ figures land on the
    calibration run trace. The score sink is the SAME deterministic
    :func:`live_runner.build_score_sink` — calibration adds no new score transport.
    """
    from .live_runner import build_score_sink  # noqa: PLC0415

    score_sink = build_score_sink(langfuse)
    for trace_id, point_credits in point_credits_by_trace.items():
        write_human_point_scores(
            point_credits=point_credits, trace_id=trace_id, score_sink=score_sink
        )
    write_calibration_scores(
        primary=primary,
        judge_judge=judge_judge,
        trace_id=run_trace_id,
        score_sink=score_sink,
    )


__all__ = [
    "resolve_calibration_queue_id",
    "build_calibration_queue_sink",
    "write_calibration_back",
]
