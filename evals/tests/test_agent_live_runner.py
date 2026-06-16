"""Agent live-runner wiring tests (issue #50).

The agent analog of :mod:`test_live_runner`. In NESTED mode the harness owns the
ROOT observation ``owners-manual.harness.item``; #48/#49 record the full envelope
on the TS child spans but never clobber the harness-owned root. So the harness
must write the full envelope to that root itself — and for the agent arm that
envelope also carries ``degraded``.

These tests inject a FAKE Langfuse client (no live server) and a fake SSE chat
client, then assert the harness root observation's ``output`` is the full
envelope (``behaviorClass``, ``answer``, ``claims``, ``degraded``).
"""

from __future__ import annotations

from typing import Any

from owners_manual_evals.agent_client import ChatResult
from owners_manual_evals.agent_live_runner import build_agent_answer
from owners_manual_evals.citable_path import CitablePath, CitablePathSegment
from owners_manual_evals.golden_item import AnswerPoint, GoldenItem, Provenance


def _item(item_id: str = "answer-repair") -> GoldenItem:
    return GoldenItem(
        id=item_id,
        behavior_class="answer",
        verified=True,
        question="who repairs the unit?",
        answer_points=(AnswerPoint(id="p", text="t"),),
        required_cites=(),
        provenance=Provenance(source="x", reference="y"),
    )


_CITE = CitablePath(
    document_id="rta-2006",
    segments=(
        CitablePathSegment("part", "III"),
        CitablePathSegment("section", "20"),
        CitablePathSegment("subsection", "1"),
    ),
)


def _chat_result(*, degraded: bool = False) -> ChatResult:
    return ChatResult(
        trace_id="c" * 32,
        behavior_class="answer",
        candidate_cites=(_CITE,),
        retrieved_path_keys=("rta-2006|part:III|section:20|subsection:1",),
        corpus_build_hash="a" * 64,
        pipeline_config_hash="f" * 64,
        latency_ms={"total": 1234.0},
        degraded=degraded,
        tokens=("The ", "landlord ", "must..."),
        answer_text="The landlord must maintain the unit.",
    )


class _FakeSpan:
    """Captures the output written to the harness-owned root observation."""

    def __init__(self) -> None:
        self.id = "d" * 16
        self.outputs: list[Any] = []

    def update(self, *, output: Any) -> None:
        self.outputs.append(output)

    def __enter__(self) -> _FakeSpan:
        return self

    def __exit__(self, *exc: object) -> bool:
        return False


class _FakeLangfuse:
    """A fake Langfuse v4 client: records the harness span and its output."""

    def __init__(self) -> None:
        self.span = _FakeSpan()

    def create_trace_id(self, *, seed: str) -> str:
        return "c" * 32

    def start_as_current_observation(self, **kwargs: Any) -> _FakeSpan:
        return self.span


class _FakeChatClient:
    """A fake AgentChatClient: records the call and returns a canned result."""

    def __init__(self, result: ChatResult) -> None:
        self._result = result
        self.calls: list[dict] = []

    def chat(self, **kwargs: Any) -> ChatResult:
        self.calls.append(dict(kwargs))
        return self._result


def test_harness_root_records_the_full_envelope_with_degraded() -> None:
    langfuse = _FakeLangfuse()
    client = _FakeChatClient(_chat_result(degraded=True))
    answer = build_agent_answer(
        service_url="http://svc:8787",
        run_name="agent-v0",
        langfuse=langfuse,
        client=client,
    )

    answer(_item())

    assert len(langfuse.span.outputs) == 1
    output = langfuse.span.outputs[0]
    # The full envelope plus degraded — not just { behaviorClass, degraded }.
    assert set(output) == {"behaviorClass", "answer", "claims", "degraded"}
    assert output["behaviorClass"] == "answer"
    assert output["answer"] == "The landlord must maintain the unit."
    assert output["degraded"] is True


def test_harness_root_claims_carry_the_envelope_cite_wire_shape() -> None:
    langfuse = _FakeLangfuse()
    client = _FakeChatClient(_chat_result())
    answer = build_agent_answer(
        service_url="http://svc:8787",
        run_name="agent-v0",
        langfuse=langfuse,
        client=client,
    )

    answer(_item())

    output = langfuse.span.outputs[0]
    assert output["degraded"] is False
    assert output["claims"] == [
        {
            "cites": [
                {
                    "documentId": "rta-2006",
                    "segments": [
                        {"kind": "part", "label": "III"},
                        {"kind": "section", "label": "20"},
                        {"kind": "subsection", "label": "1"},
                    ],
                }
            ]
        }
    ]


def test_injected_client_nests_the_agent_under_the_harness_span() -> None:
    langfuse = _FakeLangfuse()
    client = _FakeChatClient(_chat_result())
    answer = build_agent_answer(
        service_url="http://svc:8787",
        run_name="agent-v0",
        langfuse=langfuse,
        client=client,
    )

    outcome = answer(_item())

    assert client.calls[0]["parent_span_id"] == "d" * 16
    assert client.calls[0]["trace_id"] == "c" * 32
    assert outcome.answer_text == "The landlord must maintain the unit."


def test_no_langfuse_arm_writes_no_harness_span_and_still_propagates() -> None:
    """The ``--no-langfuse`` path is unchanged: it propagates a deterministic
    trace id but opens no harness span (so there is no root to enrich)."""
    client = _FakeChatClient(_chat_result())
    answer = build_agent_answer(
        service_url="http://svc:8787",
        run_name="agent-v0",
        langfuse=None,
        client=client,
    )

    outcome = answer(_item())

    # No parent span id is sent (no harness span exists to nest under).
    assert client.calls[0].get("parent_span_id") is None
    assert client.calls[0]["trace_id"] is not None
    assert outcome.observed_behavior == "answer"
