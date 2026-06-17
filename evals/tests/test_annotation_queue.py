"""Annotation-queue enqueue tests (issue #21 AC1).

Every full-tier run pushes its FAILURES into a Langfuse annotation queue
(CONTEXT.md, "Disposition"). The enqueue path threads through an INJECTED sink —
the same injection shape :mod:`judge_scores` / the deterministic score sink use —
so the offline suite exercises exactly what would be written to the queue with no
Langfuse server. The live sink (the real ``annotation_queues`` API) is wired
separately and is live-by-design.

Each enqueued item is keyed by the failed item's TRACE id (the queue annotates
traces), so the disposition score the annotator sets lands on the same trace.
"""

from __future__ import annotations

from owners_manual_evals.annotation_queue import enqueue_failures, enqueue_run_failures
from owners_manual_evals.citable_path import CitablePath, CitablePathSegment
from owners_manual_evals.disposition import FailedItem, FailureStage
from owners_manual_evals.golden_item import AnswerPoint, GoldenItem, Provenance
from owners_manual_evals.metrics import ItemScore


def _failure(item_id: str, trace_id: str, *, corpus: str = "tenancy") -> FailedItem:
    return FailedItem(
        item_id=item_id,
        trace_id=trace_id,
        behavior_class="answer",
        corpus=corpus,
        stage=FailureStage.SYNTHESIS,
    )


def _item(item_id: str) -> GoldenItem:
    return GoldenItem(
        id=item_id,
        behavior_class="answer",
        verified=True,
        question="q?",
        answer_points=(AnswerPoint(id="p", text="t"),),
        required_cites=(
            CitablePath(document_id="rta-2006", segments=(CitablePathSegment("section", "1"),)),
        ),
        provenance=Provenance(source="x", reference="y"),
    )


def _score(item_id: str, *, strict_pass: bool) -> ItemScore:
    return ItemScore(
        item_id=item_id,
        behavior_class="answer",
        behavior_match=strict_pass,
        cite_precision=1.0,
        cite_recall=1.0 if strict_pass else 0.5,
        retrieval_hit_rate=1.0,
        strict_pass=strict_pass,
    )


def test_each_failure_is_enqueued_keyed_by_its_trace_id() -> None:
    captured: list[dict] = []

    def sink(**kwargs: object) -> None:
        captured.append(dict(kwargs))

    failures = (_failure("fail-1", "a" * 32), _failure("fail-2", "b" * 32))
    enqueued = enqueue_failures(failures, queue_sink=sink)

    assert enqueued == 2
    assert [c["object_id"] for c in captured] == ["a" * 32, "b" * 32]
    # The annotation queue annotates TRACES — the object type says so.
    assert {c["object_type"] for c in captured} == {"TRACE"}


def test_item_id_rides_along_so_the_queue_is_legible() -> None:
    captured: list[dict] = []

    def sink(**kwargs: object) -> None:
        captured.append(dict(kwargs))

    enqueue_failures((_failure("answer-purchaser", "c" * 32),), queue_sink=sink)

    # The item id is carried so a human reading the queue knows which golden item
    # the trace is, not just an opaque trace hash.
    assert captured[0]["item_id"] == "answer-purchaser"


def test_no_failures_enqueues_nothing() -> None:
    captured: list[dict] = []

    def sink(**kwargs: object) -> None:
        captured.append(dict(kwargs))

    assert enqueue_failures((), queue_sink=sink) == 0
    assert captured == []


# --- the run-level orchestration (AC1: auto-enqueue during a run) -----------


def test_run_failures_auto_enqueue_only_the_strict_pass_misses() -> None:
    # The whole-run path: from a run's scores + the items + their trace ids,
    # exactly the strict-pass misses are pushed onto the queue, keyed by trace.
    scores = (_score("pass-1", strict_pass=True), _score("fail-1", strict_pass=False))
    captured: list[dict] = []

    def sink(**kwargs: object) -> None:
        captured.append(dict(kwargs))

    enqueued = enqueue_run_failures(
        scores=scores,
        items={"pass-1": _item("pass-1"), "fail-1": _item("fail-1")},
        trace_ids={"pass-1": "a" * 32, "fail-1": "b" * 32},
        queue_sink=sink,
    )

    assert enqueued == 1
    assert [c["object_id"] for c in captured] == ["b" * 32]
    assert captured[0]["item_id"] == "fail-1"


def test_run_with_no_failures_enqueues_nothing() -> None:
    scores = (_score("pass-1", strict_pass=True),)
    captured: list[dict] = []

    enqueued = enqueue_run_failures(
        scores=scores,
        items={"pass-1": _item("pass-1")},
        trace_ids={"pass-1": "a" * 32},
        queue_sink=lambda **kw: captured.append(dict(kw)),
    )
    assert enqueued == 0
    assert captured == []
