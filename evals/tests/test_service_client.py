"""Service-client tests (issue #10 AC2: trace-id propagation).

The harness drives the TS service over HTTP (evals/README: black box). These
tests pin the request shape — including the PROPAGATED trace id in the body and
the W3C ``traceparent`` header so the service spans nest under the harness span
— and the parsing of the response into a typed result. The HTTP transport is
injected, so no live network runs in the suite.
"""

from __future__ import annotations

from owners_manual_evals.service_client import (
    NaiveRagClient,
    build_traceparent,
)


class _FakeTransport:
    """Captures the last request and returns a canned answer response."""

    def __init__(self) -> None:
        self.url: str | None = None
        self.body: dict | None = None
        self.headers: dict[str, str] | None = None

    def post_json(self, url: str, body: dict, headers: dict[str, str]) -> dict:
        self.url = url
        self.body = body
        self.headers = headers
        return {
            "traceId": body.get("traceId"),
            "envelope": {
                "behaviorClass": "answer",
                "answer": "The landlord must maintain the unit.",
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
                "manifest": {"sources": []},
                "pipelineConfig": {},
                "pipelineConfigHash": "f" * 64,
                "corpusBuildHash": "a" * 64,
                "includedDocumentIds": ["rta-2006"],
            },
            "latencyMs": {"retrieval": 50.0, "synthesis": 900.0, "total": 950.0},
        }


def test_build_traceparent_is_w3c_shaped() -> None:
    tp = build_traceparent(trace_id="a" * 32, span_id="b" * 16)
    assert tp == f"00-{'a' * 32}-{'b' * 16}-01"


def test_client_posts_question_item_and_trace_id() -> None:
    transport = _FakeTransport()
    client = NaiveRagClient(base_url="http://svc:8787", transport=transport)
    client.answer(question="who repairs the unit?", item_id="answer-repair", trace_id="c" * 32)
    assert transport.url == "http://svc:8787/answer"
    assert transport.body == {
        "question": "who repairs the unit?",
        "itemId": "answer-repair",
        "traceId": "c" * 32,
    }


def test_client_sends_a_traceparent_header_for_span_nesting() -> None:
    transport = _FakeTransport()
    client = NaiveRagClient(base_url="http://svc:8787", transport=transport)
    client.answer(
        question="q",
        item_id="x",
        trace_id="c" * 32,
        parent_span_id="d" * 16,
    )
    assert transport.headers is not None
    assert transport.headers["traceparent"] == f"00-{'c' * 32}-{'d' * 16}-01"


def test_client_parses_the_response_into_a_typed_result() -> None:
    transport = _FakeTransport()
    client = NaiveRagClient(base_url="http://svc:8787", transport=transport)
    result = client.answer(question="q", item_id="x", trace_id="c" * 32)
    assert result.behavior_class == "answer"
    assert result.retrieved_path_keys == ("rta-2006|part:III|section:20|subsection:1",)
    assert result.candidate_cites[0].document_id == "rta-2006"
    assert result.corpus_build_hash == "a" * 64
    assert result.latency_ms["total"] == 950.0


def test_client_omits_trace_id_from_body_when_not_supplied() -> None:
    transport = _FakeTransport()
    client = NaiveRagClient(base_url="http://svc:8787", transport=transport)
    client.answer(question="q", item_id="x")
    assert transport.body is not None
    assert "traceId" not in transport.body
