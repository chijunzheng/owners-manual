"""Live Langfuse wiring for the disposition ritual (issue #21).

The net-new annotation-queue API, wrapped behind the SAME mockable seams the
offline suite drives (:mod:`annotation_queue`, :mod:`disposition_preflight`,
:mod:`failure_digest`) — in the spirit of :mod:`live_runner`, so the unit suite
needs no SDK and no server. Everything here is LIVE by design and is not
exercised by the offline tests; the pure logic it feeds is fully tested against
fakes.

The three live bindings:

* :func:`build_queue_sink` — an :data:`~.annotation_queue.AnnotationQueueSink`
  that POSTs each failure's trace onto a Langfuse annotation queue
  (``annotation_queues.create_queue_item``), keyed by trace id (AC1);
* :func:`read_queue_items` + :func:`build_disposition_reader` — read the previous
  run's queue and each trace's categorical ``disposition`` score back, for the
  pre-flight (AC2/AC3);
* :func:`read_dispositioned_failures` — read the dispositioned failures back FROM
  Langfuse for the release digest (AC4), so the digest is genuinely derived.

Langfuse v4 exposes annotation queues only on the lower-level API client
(``Langfuse.api.annotation_queues``); scores come back via the same client. Both
are reached lazily so importing this module never requires the SDK.
"""

from __future__ import annotations

from typing import Any

from .annotation_queue import AnnotationQueueSink
from .disposition import DISPOSITION_SCORE_NAME, FailureStage, is_valid_disposition
from .disposition_preflight import DispositionReader, QueueItem
from .failure_digest import DispositionedFailure
from .oracle import corpus_of_document_id

#: The Langfuse object type an annotation-queue item points at — we annotate the
#: harness trace each failed answer was produced on.
_TRACE_OBJECT_TYPE = "TRACE"


def build_queue_sink(langfuse: Any, *, queue_id: str) -> AnnotationQueueSink:  # pragma: no cover
    """An annotation-queue sink that enqueues each failure's trace on ``queue_id``.

    Mirrors :func:`live_runner.build_score_sink`: the pure enqueue loop calls this
    once per failure with ``object_id`` (the trace), ``object_type``, and the
    golden ``item_id`` (carried for legibility; the API keys on the trace)."""

    def sink(*, object_id: str, object_type: str, item_id: str) -> None:
        _ = item_id  # legibility only; the queue item is keyed by the trace id
        langfuse.api.annotation_queues.create_queue_item(
            queue_id,
            object_id=object_id,
            object_type=object_type,
        )

    return sink


def read_queue_items(langfuse: Any, *, queue_id: str) -> tuple[QueueItem, ...]:  # pragma: no cover
    """Read the previous run's annotation-queue items (paginated) for the pre-flight.

    The Langfuse item carries the trace id (``object_id``); the golden item id is
    not stored on the queue item, so we surface the trace id for both fields — the
    pre-flight only needs the trace to read its disposition, and the human-facing
    listing still pins the exact trace."""
    items: list[QueueItem] = []
    page = 1
    while True:
        response = langfuse.api.annotation_queues.list_queue_items(queue_id, page=page)
        data = getattr(response, "data", None) or []
        for entry in data:
            object_id = entry.object_id
            items.append(QueueItem(object_id=object_id, item_id=object_id))
        meta = getattr(response, "meta", None)
        total_pages = getattr(meta, "total_pages", page) if meta is not None else page
        if page >= total_pages:
            break
        page += 1
    return tuple(items)


def build_disposition_reader(langfuse: Any) -> DispositionReader:  # pragma: no cover
    """Read the categorical ``disposition`` score currently on a trace, or ``None``.

    A trace with no disposition score — or one whose value is not a valid closed
    verdict — reads as ``None``, so the pre-flight treats it as undispositioned."""

    def disposition_of(trace_id: str) -> str | None:
        response = langfuse.api.scores.get_many(trace_id=trace_id, name=DISPOSITION_SCORE_NAME)
        data = getattr(response, "data", None) or []
        for score in data:
            # A categorical score carries its label in ``string_value`` (``value``
            # is the numeric config index); accept whichever is a valid verdict.
            value = getattr(score, "string_value", None) or getattr(score, "value", None)
            if is_valid_disposition(value):
                return value  # type: ignore[return-value]
        return None

    return disposition_of


def read_dispositioned_failures(  # pragma: no cover
    langfuse: Any,
    *,
    queue_id: str,
) -> tuple[DispositionedFailure, ...]:
    """Read the dispositioned failures back FROM Langfuse for the release digest.

    For each queue trace it reads the disposition score plus the trace's recorded
    behavior class and the corpus of its required cites (off the harness span's
    metadata/output), so the digest is built from Langfuse data only — never the
    run's in-memory scores. A trace still lacking a valid disposition is skipped
    (it belongs to the pre-flight's open list, not the release digest)."""
    disposition_of = build_disposition_reader(langfuse)
    failures: list[DispositionedFailure] = []
    for queue_item in read_queue_items(langfuse, queue_id=queue_id):
        disposition = disposition_of(queue_item.object_id)
        if disposition is None:
            continue
        trace = langfuse.api.trace.get(queue_item.object_id)
        behavior_class, corpus, stage = _trace_dimensions(trace)
        failures.append(
            DispositionedFailure(
                item_id=_trace_item_id(trace) or queue_item.object_id,
                trace_id=queue_item.object_id,
                behavior_class=behavior_class,  # type: ignore[arg-type]
                corpus=corpus,
                stage=stage,
                disposition=disposition,  # type: ignore[arg-type]
            )
        )
    return tuple(failures)


def _trace_metadata(trace: Any) -> dict[str, Any]:  # pragma: no cover
    metadata = getattr(trace, "metadata", None)
    return dict(metadata) if isinstance(metadata, dict) else {}


def _trace_item_id(trace: Any) -> str | None:  # pragma: no cover
    input_payload = getattr(trace, "input", None)
    if isinstance(input_payload, dict):
        item_id = input_payload.get("itemId")
        if isinstance(item_id, str) and item_id:
            return item_id
    return None


def _trace_score(trace: Any, name: str) -> float | None:  # pragma: no cover
    """A numeric score value already written to the trace by the score sink."""
    for score in getattr(trace, "scores", None) or []:
        if getattr(score, "name", None) == name:
            value = getattr(score, "value", None)
            if isinstance(value, (int, float)):
                return float(value)
    return None


def _corpus_from_output(trace: Any) -> str:  # pragma: no cover
    """The corpus from the cites the harness root recorded (the full envelope's
    claims), in canonical corpus order — derived purely from what is on the trace."""
    from .oracle import CORPORA  # noqa: PLC0415

    output = getattr(trace, "output", None)
    corpora: set[str] = set()
    if isinstance(output, dict):
        for claim in output.get("claims", []) or []:
            for cite in (claim or {}).get("cites", []) or []:
                document_id = (cite or {}).get("documentId")
                if isinstance(document_id, str):
                    try:
                        corpora.add(corpus_of_document_id(document_id))
                    except ValueError:
                        continue
    return next((c for c in CORPORA if c in corpora), "none")


def _trace_dimensions(trace: Any) -> tuple[str, str, FailureStage]:  # pragma: no cover
    """The digest axes read off a harness trace, Langfuse-side: behavior class
    (metadata the harness already writes), corpus (from the cites on the recorded
    envelope), failing stage (retrieval if the trace's ``retrieval_hit_rate``
    score is < 1, else synthesis). Everything is read FROM the trace — the digest
    authors none of it."""
    behavior_class = _trace_metadata(trace).get("behaviorClass", "answer")
    corpus = _corpus_from_output(trace)
    hit_rate = _trace_score(trace, "retrieval_hit_rate")
    stage = (
        FailureStage.RETRIEVAL
        if hit_rate is not None and hit_rate < 1.0
        else FailureStage.SYNTHESIS
    )
    return behavior_class, corpus, stage


def resolve_queue_id() -> str:  # pragma: no cover
    """The annotation-queue id from the environment, raising a clear error if unset.

    The queue is a Langfuse resource created once in the UI (or via the API); the
    harness reads/writes it by id, threaded through ``LANGFUSE_DISPOSITION_QUEUE_ID``."""
    import os  # noqa: PLC0415

    queue_id = os.environ.get("LANGFUSE_DISPOSITION_QUEUE_ID") or ""
    if not queue_id:
        raise RuntimeError(
            "LANGFUSE_DISPOSITION_QUEUE_ID is not set. Create a disposition "
            "annotation queue in Langfuse (Annotate → Queues) and put its id in "
            ".env before running the full-tier experiment (CONTEXT.md, Disposition)."
        )
    return queue_id


__all__ = [
    "build_queue_sink",
    "read_queue_items",
    "build_disposition_reader",
    "read_dispositioned_failures",
    "resolve_queue_id",
]
