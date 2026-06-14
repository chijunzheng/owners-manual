"""Agent SSE client tests (issue #15 AC4).

The harness drives the agent's ``/chat`` over HTTP as a black box (ADR 0003).
These tests pin the request shape — the propagated trace id in the body plus the
W3C ``traceparent`` header for span nesting — and the SSE parsing of a token
stream + terminal ``result`` (and ``error``) into a typed result the runner
scores. The streaming transport is injected, so no live network runs.
"""

from __future__ import annotations

import json
from collections.abc import Iterable

import pytest

from owners_manual_evals.agent_client import AgentChatClient, parse_sse_events


def _frame(event: dict) -> str:
    """Render one SSE wire frame the way the TS service does."""
    return f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"


def _result_event(*, trace_id: str | None = None, degraded: bool = False) -> dict:
    return {
        "type": "result",
        "traceId": trace_id,
        "envelope": {
            "behaviorClass": "answer",
            "answer": "The landlord must keep the unit in a good state of repair.",
            "claims": [
                {
                    "text": "x",
                    "cites": [
                        {
                            "documentId": "rta-2006",
                            "segments": [
                                {"kind": "part", "label": "III"},
                                {"kind": "section", "label": "20"},
                                {"kind": "subsection", "label": "1"},
                            ],
                        }
                    ],
                }
            ],
        },
        "retrievedCitablePathKeys": ["rta-2006|part:III|section:20|subsection:1"],
        "runRecord": {
            "pipelineConfigHash": "f" * 64,
            "corpusBuildHash": "a" * 64,
        },
        "degraded": degraded,
        "latencyMs": {"total": 1234.0},
    }


class _FakeSseTransport:
    """Captures the request and replays a scripted SSE frame sequence."""

    def __init__(self, frames: Iterable[str]) -> None:
        self._frames = list(frames)
        self.url: str | None = None
        self.body: dict | None = None
        self.headers: dict[str, str] | None = None

    def stream_sse(self, url: str, body: dict, headers: dict[str, str]) -> Iterable[str]:
        self.url = url
        self.body = body
        self.headers = headers
        # Yield line-by-line exactly as urllib iterates the response body.
        for frame in self._frames:
            yield from frame.split("\n")


# --- SSE parsing -----------------------------------------------------------


def test_parse_sse_events_decodes_token_then_result() -> None:
    frames = _frame({"type": "token", "token": "Hello "}) + _frame(_result_event())
    events = list(parse_sse_events(frames.split("\n")))
    assert events[0]["type"] == "token"
    assert events[-1]["type"] == "result"


def test_parse_sse_events_skips_comments_and_blank_only_frames() -> None:
    lines = [": heartbeat", "", 'data: {"type": "token", "token": "x"}', ""]
    events = list(parse_sse_events(lines))
    assert events == [{"type": "token", "token": "x"}]


def test_parse_sse_events_tolerates_a_trailing_unterminated_frame() -> None:
    lines = ['data: {"type": "result", "ok": true}']
    events = list(parse_sse_events(lines))
    assert events == [{"type": "result", "ok": True}]


# --- client ----------------------------------------------------------------


def test_client_posts_question_item_and_trace_id() -> None:
    transport = _FakeSseTransport([_frame(_result_event(trace_id="c" * 32))])
    client = AgentChatClient(base_url="http://svc:8787", transport=transport)
    client.chat(question="who repairs the unit?", item_id="answer-repair", trace_id="c" * 32)
    assert transport.url == "http://svc:8787/chat"
    assert transport.body == {
        "question": "who repairs the unit?",
        "itemId": "answer-repair",
        "traceId": "c" * 32,
    }


def test_client_sends_a_traceparent_header_for_span_nesting() -> None:
    transport = _FakeSseTransport([_frame(_result_event(trace_id="c" * 32))])
    client = AgentChatClient(base_url="http://svc:8787", transport=transport)
    client.chat(question="q", item_id="x", trace_id="c" * 32, parent_span_id="d" * 16)
    assert transport.headers is not None
    assert transport.headers["traceparent"] == f"00-{'c' * 32}-{'d' * 16}-01"


def test_client_parses_the_terminal_result_into_a_typed_result() -> None:
    frames = (
        _frame({"type": "token", "token": "The "})
        + _frame({"type": "token", "token": "landlord."})
        + _frame(_result_event(trace_id="c" * 32))
    )
    transport = _FakeSseTransport([frames])
    client = AgentChatClient(base_url="http://svc:8787", transport=transport)
    result = client.chat(question="q", item_id="x", trace_id="c" * 32)
    assert result.behavior_class == "answer"
    assert result.retrieved_path_keys == ("rta-2006|part:III|section:20|subsection:1",)
    assert result.candidate_cites[0].document_id == "rta-2006"
    assert result.corpus_build_hash == "a" * 64
    assert result.latency_ms["total"] == 1234.0
    assert result.tokens == ("The ", "landlord.")


def test_client_captures_the_degraded_flag() -> None:
    transport = _FakeSseTransport([_frame(_result_event(degraded=True))])
    client = AgentChatClient(base_url="http://svc:8787", transport=transport)
    result = client.chat(question="q", item_id="x")
    assert result.degraded is True


def test_client_omits_trace_id_from_body_when_not_supplied() -> None:
    transport = _FakeSseTransport([_frame(_result_event())])
    client = AgentChatClient(base_url="http://svc:8787", transport=transport)
    client.chat(question="q", item_id="x")
    assert transport.body is not None
    assert "traceId" not in transport.body


def test_client_raises_on_an_error_frame() -> None:
    transport = _FakeSseTransport([_frame({"type": "error", "message": "boom"})])
    client = AgentChatClient(base_url="http://svc:8787", transport=transport)
    with pytest.raises(RuntimeError, match="boom"):
        client.chat(question="q", item_id="x")


def test_client_raises_when_no_terminal_result_arrives() -> None:
    transport = _FakeSseTransport([_frame({"type": "token", "token": "x"})])
    client = AgentChatClient(base_url="http://svc:8787", transport=transport)
    with pytest.raises(RuntimeError, match="without a terminal result"):
        client.chat(question="q", item_id="x")
