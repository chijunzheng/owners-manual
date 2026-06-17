"""The disposition pre-flight (issue #21 AC2 + AC3): block until the queue clears.

CONTEXT.md ("Disposition"): "the harness pre-flight refuses to start a new
experiment while the previous run's queue is non-empty." An experiment may launch
only once every item in the previous run's annotation queue carries a disposition
— a CATEGORICAL ``disposition`` score (one of the four closed verdicts) on its
trace. This module is that gate:

* AC2 — :func:`preflight_dispositions` RAISES :class:`UndispositionedQueueError`,
  listing the still-undispositioned items, when any queue item lacks a valid
  disposition; it returns quietly when the queue is empty or fully dispositioned.
* AC3 — a loud, LOGGED ``override`` flag lets a run proceed anyway, emitting a
  WARNING that names how many items were waved through (the escape hatch is
  audited, never silent). When there was nothing to override it stays quiet.

Both the queue and the per-trace disposition are read through INJECTED callables,
so the offline suite drives the gate against a MOCKED Langfuse (CONTEXT.md,
"Testing Decisions"): the live readers (the real ``annotation_queues`` API and
score reads) are wired in :mod:`live_annotation_queue`, live-by-design.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from .disposition import is_valid_disposition

logger = logging.getLogger(__name__)

#: Read the disposition currently on a trace: its categorical ``disposition``
#: score value, or ``None`` if none has been set. Injected so the gate is mocked.
DispositionReader = Callable[[str], str | None]


@dataclass(frozen=True, slots=True)
class QueueItem:
    """One item in the previous run's annotation queue: the trace awaiting a
    disposition, plus the golden ``item_id`` riding along so a blocked run names
    the item rather than an opaque trace hash."""

    object_id: str
    item_id: str


@dataclass(frozen=True, slots=True)
class PreflightResult:
    """The outcome of a passed pre-flight. ``overridden`` lists the items that
    were waved through by the override flag (empty on a clean pass), so the caller
    can surface exactly what the disposition ritual skipped."""

    overridden: tuple[QueueItem, ...]


class UndispositionedQueueError(RuntimeError):
    """Raised when the previous run's queue still holds undispositioned items.

    Carries the full list (:attr:`undispositioned`) so the caller can render every
    open item, not just the first — the whole queue must be cleared before the
    next experiment, so the whole list is the actionable payload.
    """

    def __init__(self, undispositioned: Sequence[QueueItem]) -> None:
        self.undispositioned: tuple[QueueItem, ...] = tuple(undispositioned)
        listed = ", ".join(f"{q.item_id} ({q.object_id})" for q in self.undispositioned)
        super().__init__(
            f"the previous run's annotation queue has {len(self.undispositioned)} "
            f"undispositioned item(s); disposition each before launching the next "
            f"experiment (CONTEXT.md, Disposition), or re-run with the override "
            f"flag to proceed anyway: {listed}"
        )


def _undispositioned(
    queue_items: Sequence[QueueItem], disposition_of: DispositionReader
) -> tuple[QueueItem, ...]:
    """The queue items whose trace lacks a VALID disposition. A score that is not
    one of the four closed verdicts (e.g. a typo) does not satisfy the gate."""
    return tuple(
        item for item in queue_items if not is_valid_disposition(disposition_of(item.object_id))
    )


def preflight_dispositions(
    *,
    queue_items: Sequence[QueueItem],
    disposition_of: DispositionReader,
    override: bool = False,
) -> PreflightResult:
    """Gate the next experiment on the previous run's disposition queue.

    Raises :class:`UndispositionedQueueError` (listing them) if any queue item is
    still undispositioned, unless ``override`` is set — in which case it logs a
    loud WARNING naming how many items were waved through and proceeds. An empty
    or fully-dispositioned queue passes silently.
    """
    open_items = _undispositioned(queue_items, disposition_of)
    if not open_items:
        return PreflightResult(overridden=())

    if override:
        logger.warning(
            "DISPOSITION GATE OVERRIDE: launching the next experiment with %d "
            "undispositioned item(s) still in the previous run's annotation queue "
            "(%s). The disposition ritual was bypassed by override — disposition "
            "these before trusting the run.",
            len(open_items),
            ", ".join(f"{q.item_id} ({q.object_id})" for q in open_items),
        )
        return PreflightResult(overridden=open_items)

    raise UndispositionedQueueError(open_items)


__all__ = [
    "DispositionReader",
    "QueueItem",
    "PreflightResult",
    "UndispositionedQueueError",
    "preflight_dispositions",
]
