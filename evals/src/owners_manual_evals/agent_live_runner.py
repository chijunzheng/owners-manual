"""Live wiring for the agent arm (issue #15 AC4): Langfuse + the SSE chat client.

The agent analog of :mod:`live_runner`'s naive-rag wiring — kept SEPARATE so the
frozen naive-rag path is never reshaped. For each item it derives a deterministic,
correlatable trace id (distinct from the naive-rag arm's, so the same item's two
arm runs are separate traces), opens a harness span tagged ``arm: agent`` when a
Langfuse client is supplied, drives the agent ``/chat`` SSE endpoint with trace-id
propagation (body trace id + ``traceparent`` header so the service's agent spans
nest under the harness span), and returns the parsed outcome the runner scores
exactly like the naive-rag outcome.

Live by design; not exercised by the unit suite (the runner loop, the metrics,
the dashboard, and the SSE client are all unit-tested against fakes).
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from .agent_client import AgentChatClient
from .golden_item import GoldenItem
from .harness_envelope import build_harness_output
from .run_naive_rag import AnswerFn, ItemOutcome

#: A seed suffix so the agent arm's trace id differs from naive-rag's for the
#: same item — the two arm runs of one item are distinct, correlatable traces.
_AGENT_SEED_SUFFIX = "agent"


def _agent_seed(run_name: str, item_id: str) -> str:
    """The agent arm's trace-id seed for one item — the SINGLE source of the
    ``:agent:`` scheme. naive-rag seeds ``run:item``; the agent arm seeds
    ``run:agent:item`` so the same item's two arm runs stay distinct traces, and so
    the disposition ritual (issue #21) enqueues agent failures under the SAME id the
    arm created rather than the naive-rag trace."""
    return f"{run_name}:{_AGENT_SEED_SUFFIX}:{item_id}"


def agent_trace_id(langfuse: Any, *, run_name: str, item_id: str) -> str:
    """The agent arm's deterministic Langfuse trace id for one item."""
    return langfuse.create_trace_id(seed=_agent_seed(run_name, item_id))


def agent_trace_ids(langfuse: Any, *, run_name: str, items: Iterable[GoldenItem]) -> dict[str, str]:
    """Per-item agent trace ids keyed by item id — what the disposition ritual
    (issue #21) enqueues agent-arm failures under, so annotators and the
    pre-flight/digest read the agent trace rather than naive-rag's."""
    return {item.id: agent_trace_id(langfuse, run_name=run_name, item_id=item.id) for item in items}


def build_agent_answer(
    *,
    service_url: str,
    run_name: str,
    langfuse: Any | None,
    client: AgentChatClient | None = None,
) -> AnswerFn:
    """Build the agent arm's per-item answer function.

    When ``langfuse`` is a client, each item opens a harness span (tagged for the
    agent arm) and the service's agent spans nest under it via ``traceparent``.
    When ``langfuse`` is ``None`` (``--no-langfuse``), a deterministic trace id is
    still propagated so the service's own trace is correlatable, but no harness
    span/score is emitted and no ``parent_span_id`` is sent (there is no span to
    nest under).

    ``client`` is an injection seam (issue #50): a unit test can pass a fake chat
    client (with a fake ``langfuse``) and assert what the harness writes to its
    OWNED root observation — no live server. It defaults to the live SSE client,
    so the production behavior is unchanged.
    """
    client = client if client is not None else AgentChatClient(base_url=service_url)

    if langfuse is None:
        import hashlib  # noqa: PLC0415

        def answer_offline(item: GoldenItem) -> ItemOutcome:
            trace_id = hashlib.sha256(_agent_seed(run_name, item.id).encode()).hexdigest()[:32]
            result = client.chat(question=item.question, item_id=item.id, trace_id=trace_id)
            return _outcome(item, result, trace_id)

        return answer_offline

    def answer_live(item: GoldenItem) -> ItemOutcome:
        trace_id = agent_trace_id(langfuse, run_name=run_name, item_id=item.id)
        with langfuse.start_as_current_observation(
            trace_context={"trace_id": trace_id},
            name="owners-manual.harness.item",
            as_type="span",
            input={"itemId": item.id, "question": item.question},
            metadata={"arm": "agent", "behaviorClass": item.behavior_class, "runName": run_name},
        ) as span:
            result = client.chat(
                question=item.question,
                item_id=item.id,
                trace_id=trace_id,
                parent_span_id=span.id,
            )
            # The harness OWNS this root observation in nested mode (the TS tracer
            # never clobbers it — #48). Record the full envelope here (+ degraded),
            # not just the behavior class, so an eval-run trace shows the answer at
            # the top (issue #50). The `stuff` arm runs root-mode (the TS service
            # owns the trace) and is already full-envelope at root via #48.
            span.update(
                output=build_harness_output(
                    behavior_class=result.behavior_class,
                    answer_text=result.answer_text,
                    claims=result.claims,
                    degraded=result.degraded,
                )
            )
        return _outcome(item, result, trace_id)

    return answer_live


def _outcome(item: GoldenItem, result: Any, trace_id: str) -> ItemOutcome:
    """Map an agent :class:`ChatResult` onto the runner's :class:`ItemOutcome`."""
    return ItemOutcome(
        item_id=item.id,
        observed_behavior=result.behavior_class,
        candidate_cites=result.candidate_cites,
        retrieved_path_keys=result.retrieved_path_keys,
        latency_ms=dict(result.latency_ms),
        cost_usd=0.0,  # cost-per-item lands when Vertex usage flows through (later)
        trace_id=trace_id,
        answer_text=getattr(result, "answer_text", ""),
    )


__all__ = ["agent_trace_id", "agent_trace_ids", "build_agent_answer"]
