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

from typing import Any

from .agent_client import AgentChatClient
from .golden_item import GoldenItem
from .run_naive_rag import AnswerFn, ItemOutcome

#: A seed suffix so the agent arm's trace id differs from naive-rag's for the
#: same item — the two arm runs of one item are distinct, correlatable traces.
_AGENT_SEED_SUFFIX = "agent"


def build_agent_answer(
    *,
    service_url: str,
    run_name: str,
    langfuse: Any | None,
) -> AnswerFn:
    """Build the agent arm's per-item answer function.

    When ``langfuse`` is a client, each item opens a harness span (tagged for the
    agent arm) and the service's agent spans nest under it via ``traceparent``.
    When ``langfuse`` is ``None`` (``--no-langfuse``), a deterministic trace id is
    still propagated so the service's own trace is correlatable, but no harness
    span/score is emitted and no ``parent_span_id`` is sent (there is no span to
    nest under).
    """
    client = AgentChatClient(base_url=service_url)

    if langfuse is None:
        import hashlib  # noqa: PLC0415

        def answer_offline(item: GoldenItem) -> ItemOutcome:
            trace_id = hashlib.sha256(
                f"{run_name}:{_AGENT_SEED_SUFFIX}:{item.id}".encode()
            ).hexdigest()[:32]
            result = client.chat(question=item.question, item_id=item.id, trace_id=trace_id)
            return _outcome(item, result, trace_id)

        return answer_offline

    def answer_live(item: GoldenItem) -> ItemOutcome:
        trace_id = langfuse.create_trace_id(seed=f"{run_name}:{_AGENT_SEED_SUFFIX}:{item.id}")
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
            span.update(
                output={"behaviorClass": result.behavior_class, "degraded": result.degraded}
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


__all__ = ["build_agent_answer"]
