"""Live wiring for the naive-rag runner (issue #10): Langfuse + service client.

This is the glue the pure runner (``run_naive_rag``) injects. For each item it:

1. derives a DETERMINISTIC trace id from the run name + item id
   (``Langfuse.create_trace_id(seed=…)``), so re-runs of the same item land on a
   stable, correlatable trace;
2. opens a Python span under that trace context (the harness's parent span),
   reads its span id, and POSTs to the service with the trace id in the body and
   a ``traceparent`` header naming the parent span — so the TS service's
   Langfuse spans NEST under the harness span in one shared trace (AC2);
3. returns the parsed outcome to the runner for deterministic scoring.

The score sink writes each deterministic metric back to Langfuse with
``create_score(trace_id=…)``, correlating the score to the exact service trace.
Langfuse is the sole system of record (CONTEXT.md) — these are native
Datasets/Experiments/Scores, not bespoke on-disk artifacts.

Live by design; not exercised by the unit suite (the runner loop, the metrics,
the dashboard, and the client are all unit-tested against fakes).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .document_tree import DocumentTree
from .golden_item import GoldenItem
from .harness_envelope import build_harness_output
from .run_naive_rag import AnswerFn, ItemOutcome
from .service_client import NaiveRagClient

#: Langfuse score data type for the deterministic 0/1 and ratio metrics.
_NUMERIC = "NUMERIC"


def _build_langfuse() -> Any:
    """Construct the Langfuse v4 client, importing lazily so unit tests need no
    SDK or server. Raises if credentials are missing or rejected — a clear,
    early failure beats N silent 401 export drops mid-run."""
    import os  # noqa: PLC0415
    import re  # noqa: PLC0415

    from langfuse import Langfuse  # noqa: PLC0415

    public_key = os.environ.get("LANGFUSE_PUBLIC_KEY") or ""
    secret_key = os.environ.get("LANGFUSE_SECRET_KEY") or ""
    if not public_key or not secret_key:
        raise RuntimeError(
            "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set "
            "(copy .env.example to .env and fill in the project keys)."
        )
    if re.search(r"PLACEHOLDER|CHANGEME", f"{public_key}{secret_key}", re.IGNORECASE):
        raise RuntimeError(
            "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY are still placeholders. "
            "Mint a project key pair in the Langfuse UI (Settings → API Keys) and put "
            "them in .env before running with trace export."
        )

    client = Langfuse()
    if not client.auth_check():
        raise RuntimeError(
            "Langfuse rejected the configured credentials (auth_check failed). "
            "Confirm LANGFUSE_HOST and the project key pair in .env."
        )
    return client


def build_live_answer(
    *,
    service_url: str,
    run_name: str,
    documents: Sequence[DocumentTree],
    langfuse: Any | None = None,
    client: NaiveRagClient | None = None,
) -> tuple[AnswerFn, Any]:
    """Build the per-item answer function and return it with the Langfuse client.

    The returned function opens a propagated trace per item and drives the
    service client; the client reuses the trace id, so harness and service share
    one trace. ``documents`` is accepted for symmetry with the scoring path
    (cite parsing happens in the client) and to keep the signature stable.

    ``langfuse`` and ``client`` are an injection seam (issue #50): a unit test can
    pass a fake client / span recorder and assert what the harness writes to its
    OWNED root observation — no live Langfuse server. Both default to the live
    bindings, so the production behavior is unchanged.
    """
    langfuse = langfuse if langfuse is not None else _build_langfuse()
    client = client if client is not None else NaiveRagClient(base_url=service_url)
    _ = documents  # cites are parsed in the client; kept for a stable signature

    def answer(item: GoldenItem) -> ItemOutcome:
        # Deterministic, correlatable trace id from the run + item.
        trace_id = langfuse.create_trace_id(seed=f"{run_name}:{item.id}")

        with langfuse.start_as_current_observation(
            trace_context={"trace_id": trace_id},
            name="owners-manual.harness.item",
            as_type="span",
            input={"itemId": item.id, "question": item.question},
            metadata={
                "arm": "naive-rag",
                "behaviorClass": item.behavior_class,
                "runName": run_name,
            },
        ) as span:
            # The REAL span id (not an invented one) — the service nests its
            # spans under this exact observation (Codex P2, PR #39).
            result = client.answer(
                question=item.question,
                item_id=item.id,
                trace_id=trace_id,
                parent_span_id=span.id,
            )
            # The harness OWNS this root observation in nested mode (the TS tracer
            # never clobbers it — #48). Record the full envelope here, not just
            # the behavior class, so an eval-run trace shows the answer at the top
            # (issue #50). The `stuff` arm runs root-mode (the TS service owns the
            # trace) and is already full-envelope at root via #48 — no change.
            span.update(
                output=build_harness_output(
                    behavior_class=result.behavior_class,
                    answer_text=result.answer_text,
                    claims=result.claims,
                )
            )

        return ItemOutcome(
            item_id=item.id,
            observed_behavior=result.behavior_class,
            candidate_cites=result.candidate_cites,
            retrieved_path_keys=result.retrieved_path_keys,
            retrieved_texts=result.retrieved_texts,
            latency_ms=dict(result.latency_ms),
            cost_usd=0.0,  # cost-per-item lands when Vertex usage flows through (#14+)
            trace_id=trace_id,
            answer_text=result.answer_text,
        )

    return answer, langfuse


def build_score_sink(langfuse: Any):  # noqa: ANN201 — Callable returned for the runner
    """Return a score sink that writes deterministic scores to Langfuse,
    correlated to the service trace by id."""

    def sink(*, trace_id: str | None, name: str, value: float) -> None:
        if trace_id is None:
            return
        langfuse.create_score(name=name, value=value, trace_id=trace_id, data_type=_NUMERIC)

    return sink


def finalize_langfuse(langfuse: Any) -> None:
    """Flush buffered traces and scores so a short-lived run is durable. A
    ``None`` client (``--no-langfuse``) is a no-op."""
    if langfuse is not None:
        langfuse.flush()


def build_offline_answer(*, service_url: str, run_name: str) -> AnswerFn:
    """A no-Langfuse answer function: still PROPAGATES a deterministic trace id
    to the service (so the service's own Langfuse trace is correlatable), but
    the harness emits no Python spans/scores.

    No ``parent_span_id`` is sent: the harness creates no span, so naming one
    would nest the service under a nonexistent parent. The service falls back
    to creating the trace itself with the propagated id.

    Lets the dashboard (AC1) and the service's trace export (AC2) be exercised
    when the harness-side Langfuse keys are not yet provisioned. The trace id is
    derived deterministically without a Langfuse client.
    """
    import hashlib  # noqa: PLC0415

    client = NaiveRagClient(base_url=service_url)

    def answer(item: GoldenItem) -> ItemOutcome:
        trace_id = hashlib.sha256(f"{run_name}:{item.id}".encode()).hexdigest()[:32]
        result = client.answer(
            question=item.question,
            item_id=item.id,
            trace_id=trace_id,
        )
        return ItemOutcome(
            item_id=item.id,
            observed_behavior=result.behavior_class,
            candidate_cites=result.candidate_cites,
            retrieved_path_keys=result.retrieved_path_keys,
            retrieved_texts=result.retrieved_texts,
            latency_ms=dict(result.latency_ms),
            cost_usd=0.0,
            trace_id=trace_id,
            answer_text=result.answer_text,
        )

    return answer


def noop_score_sink(*, trace_id: str | None, name: str, value: float) -> None:
    """A score sink that drops scores — used with ``--no-langfuse``."""
    _ = (trace_id, name, value)


__all__ = [
    "build_live_answer",
    "build_offline_answer",
    "build_score_sink",
    "finalize_langfuse",
    "noop_score_sink",
]
