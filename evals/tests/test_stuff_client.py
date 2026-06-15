"""Stuffing-arm HTTP client tests (issue #18).

The harness drives the TS service as a black box over HTTP (ADR 0003). This
client POSTs to ``/stuff`` and ``/stuff-oracle`` and parses the response — shaped
like :class:`AnswerResult` so the runner scores all four arms identically, plus
the stuffing-specific fields (stuffed source count, token usage, honest cost,
order seed). The HTTP transport is injected so the suite runs offline.
"""

from __future__ import annotations

from owners_manual_evals.stuff_client import StuffClient


class _FakeTransport:
    """Captures the last POST and returns a canned stuff response."""

    def __init__(self, response: dict) -> None:
        self.response = response
        self.url: str | None = None
        self.body: dict | None = None
        self.headers: dict[str, str] | None = None

    def post_json(self, url: str, body: dict, headers: dict[str, str]) -> dict:
        self.url = url
        self.body = body
        self.headers = headers
        return self.response


def _response() -> dict:
    return {
        "traceId": "a" * 32,
        "arm": "stuff",
        "envelope": {
            "behaviorClass": "answer",
            "answer": "The landlord must keep the unit in repair.",
            "claims": [
                {
                    "text": "…",
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
        "stuffedSourceCount": 42,
        "usage": {"promptTokens": 1000, "cachedPromptTokens": 900, "completionTokens": 50},
        "costUsd": 0.0123,
        "orderSeed": 0,
        "runRecord": {"corpusBuildHash": "f" * 64, "pipelineConfigHash": "e" * 64},
        "latencyMs": {"synthesis": 800.0, "total": 820.0},
    }


def test_stuff_posts_to_the_stuff_route_and_parses_the_envelope() -> None:
    transport = _FakeTransport(_response())
    client = StuffClient(base_url="http://localhost:8787", transport=transport)
    result = client.stuff(question="who repairs the unit?", item_id="answer-1", trace_id="a" * 32)

    assert transport.url == "http://localhost:8787/stuff"
    assert result.arm == "stuff"
    assert result.behavior_class == "answer"
    assert result.candidate_cites[0].document_id == "rta-2006"
    assert result.retrieved_path_keys == ("rta-2006|part:III|section:20|subsection:1",)


def test_stuff_parses_the_stuffing_specific_fields() -> None:
    transport = _FakeTransport(_response())
    client = StuffClient(base_url="http://localhost:8787", transport=transport)
    result = client.stuff(question="q", item_id="x")
    assert result.stuffed_source_count == 42
    assert result.cost_usd == 0.0123
    assert result.usage["cachedPromptTokens"] == 900
    assert result.order_seed == 0


def test_stuff_passes_the_order_probe_seed_in_the_body() -> None:
    transport = _FakeTransport({**_response(), "orderSeed": 3})
    client = StuffClient(base_url="http://localhost:8787", transport=transport)
    result = client.stuff(question="q", item_id="x", order_seed=3)
    assert transport.body is not None and transport.body["orderSeed"] == 3
    assert result.order_seed == 3


def test_stuff_oracle_posts_to_the_oracle_route_with_routed_corpora() -> None:
    response = {**_response(), "arm": "stuff-oracle", "stuffedSourceCount": 10}
    transport = _FakeTransport(response)
    client = StuffClient(base_url="http://localhost:8787", transport=transport)
    result = client.stuff_oracle(question="q", item_id="x", corpora=("tenancy",))

    assert transport.url == "http://localhost:8787/stuff-oracle"
    assert transport.body is not None and transport.body["corpora"] == ["tenancy"]
    assert result.arm == "stuff-oracle"
    assert result.stuffed_source_count == 10


def test_stuff_propagates_trace_id_in_body_and_traceparent_header() -> None:
    transport = _FakeTransport(_response())
    client = StuffClient(base_url="http://localhost:8787", transport=transport)
    client.stuff(question="q", item_id="x", trace_id="a" * 32, parent_span_id="b" * 16)
    assert transport.body is not None and transport.body["traceId"] == "a" * 32
    assert transport.headers is not None
    assert transport.headers["traceparent"] == f"00-{'a' * 32}-{'b' * 16}-01"
