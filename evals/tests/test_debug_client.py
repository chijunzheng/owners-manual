"""Retrieval-debug client tests (#14 AC2/AC4).

The harness reads hybrid retrieval through the TS service's ``/retrieve/debug``
endpoint as a black box (ADR 0003). This client POSTs the question and parses
the candidates WITH their stage-provenance, so the live full-corpus
hybrid-vs-vector comparison can be driven the same way as the offline one. The
HTTP transport is injected so the suite runs offline.
"""

from __future__ import annotations

from owners_manual_evals.debug_client import RetrieveDebugClient


class _FakeTransport:
    def __init__(self, response: dict) -> None:
        self._response = response
        self.calls: list[tuple[str, dict, dict]] = []

    def post_json(self, url: str, body: dict, headers: dict[str, str]) -> dict:
        self.calls.append((url, body, headers))
        return self._response


_RESPONSE = {
    "question": "is my no-pet clause void?",
    "candidateCount": 2,
    "queryDimensions": 1024,
    "candidates": [
        {
            "documentId": "rta-2006",
            "citablePathKey": "rta-2006|part:II|section:14",
            "text": "A provision prohibiting animals is void.",
            "stage": "hybrid",
            "stages": ["bm25", "vector"],
            "stageRanks": {"vector": 1, "bm25": 1},
            "rrfScore": 0.032,
            "authorityLevel": "act",
        },
        {
            "documentId": "fixture-lease",
            "citablePathKey": "fixture-lease|section:pets|clause:p-1",
            "text": "No pets of any kind.",
            "stage": "vector",
            "stages": ["vector"],
            "stageRanks": {"vector": 2},
            "rrfScore": 0.016,
            "authorityLevel": "contract",
        },
    ],
}


def test_posts_question_and_parses_candidates() -> None:
    transport = _FakeTransport(_RESPONSE)
    client = RetrieveDebugClient(base_url="http://svc", transport=transport)
    result = client.retrieve(question="is my no-pet clause void?")
    assert transport.calls[0][0] == "http://svc/retrieve/debug"
    assert transport.calls[0][1]["question"] == "is my no-pet clause void?"
    assert len(result.candidates) == 2


def test_exposes_path_keys_for_the_hit_rate_metric() -> None:
    client = RetrieveDebugClient(base_url="http://svc", transport=_FakeTransport(_RESPONSE))
    result = client.retrieve(question="q")
    assert result.retrieved_path_keys == (
        "rta-2006|part:II|section:14",
        "fixture-lease|section:pets|clause:p-1",
    )


def test_preserves_stage_provenance_per_candidate() -> None:
    client = RetrieveDebugClient(base_url="http://svc", transport=_FakeTransport(_RESPONSE))
    result = client.retrieve(question="q")
    top = result.candidates[0]
    assert top.stage == "hybrid"
    assert set(top.stages) == {"vector", "bm25"}
    assert top.stage_ranks == {"vector": 1, "bm25": 1}
    assert top.authority_level == "act"


def test_passes_topk_and_authority_filter_to_the_service() -> None:
    transport = _FakeTransport(_RESPONSE)
    client = RetrieveDebugClient(base_url="http://svc", transport=transport)
    client.retrieve(question="q", top_k=5, authority_levels=("act", "regulation"))
    body = transport.calls[0][1]
    assert body["topK"] == 5
    assert body["authorityLevels"] == ["act", "regulation"]


def test_passes_mode_to_the_service_for_the_vector_only_baseline() -> None:
    transport = _FakeTransport(_RESPONSE)
    client = RetrieveDebugClient(base_url="http://svc", transport=transport)
    client.retrieve(question="q", mode="vector")
    assert transport.calls[0][1]["mode"] == "vector"

    transport2 = _FakeTransport(_RESPONSE)
    RetrieveDebugClient(base_url="http://svc", transport=transport2).retrieve(question="q")
    # mode omitted -> the service defaults to hybrid; the body need not carry it
    assert transport2.calls[0][1].get("mode") in (None, "hybrid")
