"""Disposition pre-flight tests (issue #21 AC2 + AC3).

CONTEXT.md ("Disposition"): "the harness pre-flight refuses to start a new
experiment while the previous run's queue is non-empty." Concretely, before a
full-tier experiment may launch, every item in the previous run's annotation
queue must carry a disposition (a CATEGORICAL ``disposition`` score on its
trace). The pre-flight:

* AC2 — RAISES, listing the still-undispositioned items, when any queue item
  lacks a disposition;
* AC2 — passes silently when the queue is empty or every item is dispositioned;
* AC3 — a loud, LOGGED override flag lets a run proceed anyway (the escape hatch
  is audited, never silent).

Tested against a MOCKED Langfuse (CONTEXT.md, "Testing Decisions"): the queue
reader and the disposition reader are injected, so no live server is touched.
"""

from __future__ import annotations

import logging

import pytest

from owners_manual_evals.disposition_preflight import (
    QueueItem,
    UndispositionedQueueError,
    preflight_dispositions,
)


def _queue(*object_ids: str) -> tuple[QueueItem, ...]:
    # Each queue item is a trace awaiting a disposition; item_id rides along so a
    # raised error names the golden item, not just a trace hash.
    return tuple(QueueItem(object_id=oid, item_id=f"item-{oid[0]}") for oid in object_ids)


def test_empty_queue_passes_the_preflight() -> None:
    # No prior failures awaiting disposition ⇒ nothing blocks the next experiment.
    preflight_dispositions(
        queue_items=(),
        disposition_of=lambda _trace_id: None,
    )


def test_fully_dispositioned_queue_passes() -> None:
    # Every queued trace has a disposition ⇒ the ritual is satisfied, run proceeds.
    preflight_dispositions(
        queue_items=_queue("a" * 32, "b" * 32),
        disposition_of=lambda _trace_id: "bug",
    )


def test_undispositioned_item_blocks_and_is_listed() -> None:
    dispositions = {"a" * 32: "bug", "b" * 32: None}
    with pytest.raises(UndispositionedQueueError) as excinfo:
        preflight_dispositions(
            queue_items=_queue("a" * 32, "b" * 32),
            disposition_of=lambda trace_id: dispositions[trace_id],
        )
    # The error lists the undispositioned trace(s) — not the dispositioned one.
    undispositioned = excinfo.value.undispositioned
    assert [q.object_id for q in undispositioned] == ["b" * 32]
    # The human-facing message names the still-open item.
    assert "item-b" in str(excinfo.value)


def test_all_undispositioned_are_listed_not_just_the_first() -> None:
    with pytest.raises(UndispositionedQueueError) as excinfo:
        preflight_dispositions(
            queue_items=_queue("a" * 32, "b" * 32, "c" * 32),
            disposition_of=lambda _trace_id: None,
        )
    assert {q.object_id for q in excinfo.value.undispositioned} == {
        "a" * 32,
        "b" * 32,
        "c" * 32,
    }


def test_override_proceeds_despite_undispositioned_items() -> None:
    # AC3: the override flag lets the run start even with an open queue.
    result = preflight_dispositions(
        queue_items=_queue("a" * 32),
        disposition_of=lambda _trace_id: None,
        override=True,
    )
    # Returns the items it waved through, so the caller can surface them.
    assert [q.object_id for q in result.overridden] == ["a" * 32]


def test_override_logs_loudly_at_warning(caplog: pytest.LogCaptureFixture) -> None:
    # AC3: "logs loudly" — a WARNING that the disposition gate was overridden,
    # naming how many items were waved through (audited, not silent).
    with caplog.at_level(logging.WARNING):
        preflight_dispositions(
            queue_items=_queue("a" * 32, "b" * 32),
            disposition_of=lambda _trace_id: None,
            override=True,
        )
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert warnings, "override must emit at least one WARNING"
    assert any("override" in r.getMessage().lower() for r in warnings)
    # The count of waved-through items is in the loud message.
    assert any("2" in r.getMessage() for r in warnings)


def test_override_does_not_log_when_queue_is_already_clean(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # No loud warning when there was nothing to override — the alarm is reserved
    # for an actually-bypassed gate.
    with caplog.at_level(logging.WARNING):
        preflight_dispositions(
            queue_items=_queue("a" * 32),
            disposition_of=lambda _trace_id: "noise",
            override=True,
        )
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


def test_an_invalid_disposition_value_does_not_count_as_dispositioned() -> None:
    # A score that is not one of the four closed verdicts is not a real
    # disposition; the item still blocks (a typo'd label cannot satisfy the gate).
    with pytest.raises(UndispositionedQueueError):
        preflight_dispositions(
            queue_items=_queue("a" * 32),
            disposition_of=lambda _trace_id: "todo",
        )
