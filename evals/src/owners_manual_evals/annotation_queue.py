"""Push run failures into the Langfuse annotation queue (issue #21 AC1).

Every full-tier run auto-enqueues its FAILURES into a Langfuse annotation queue
(CONTEXT.md, "Disposition"): each failed item becomes a queue item keyed by the
TRACE it was produced on, so the categorical disposition an annotator later sets
lands on that same trace. This module owns the PURE enqueue loop, threaded
through an INJECTED ``AnnotationQueueSink`` — the same injection/mocking shape
:mod:`judge_scores` and the deterministic score sink use — so the offline suite
asserts exactly what would be written to the queue with no Langfuse server. The
live sink (the real ``annotation_queues`` API) lives in :mod:`live_annotation_queue`.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence

from .disposition import FailedItem, failed_items_from_scores
from .golden_item import GoldenItem
from .metrics import ItemScore

#: The annotation-queue sink signature — kwargs-only so the live impl can add
#: fields (queue id, request options) without breaking this pure call site.
#: Mirrors ``run_naive_rag.ScoreSink``.
AnnotationQueueSink = Callable[..., None]


def enqueue_failures(failures: Sequence[FailedItem], *, queue_sink: AnnotationQueueSink) -> int:
    """Enqueue each failure as an annotation-queue item keyed by its trace id.

    Returns the number enqueued. ``object_type`` is ``"TRACE"`` because the queue
    annotates traces; the golden ``item_id`` rides along so a human reading the
    queue sees which item the trace is, not just an opaque hash.
    """
    enqueued = 0
    for failure in failures:
        queue_sink(
            object_id=failure.trace_id,
            object_type="TRACE",
            item_id=failure.item_id,
        )
        enqueued += 1
    return enqueued


def enqueue_run_failures(
    *,
    scores: Sequence[ItemScore],
    items: Mapping[str, GoldenItem],
    trace_ids: Mapping[str, str | None],
    queue_sink: AnnotationQueueSink,
) -> int:
    """The whole-run path (AC1): derive a run's failures from its deterministic
    scores and push exactly the strict-pass misses onto the queue.

    Composes :func:`~.disposition.failed_items_from_scores` (which selects the
    misses and joins each to its trace) with :func:`enqueue_failures`. The frozen
    runners are untouched: the live wiring hands this the scores, items, and the
    deterministic per-item trace ids it already has.
    """
    failures = failed_items_from_scores(scores, items=items, trace_ids=trace_ids)
    return enqueue_failures(failures, queue_sink=queue_sink)


__all__ = ["AnnotationQueueSink", "enqueue_failures", "enqueue_run_failures"]
