"""Naive-rag live-runner wiring tests (issue #50).

In NESTED mode (the live eval-harness path) the Python harness PROPAGATES a
``traceparent`` and OWNS the trace, so it owns the ROOT observation
``owners-manual.harness.item``. #48/#49 (the TS half) record the full envelope on
the TS service's child spans, but the TS tracer deliberately never clobbers the
harness-owned root in nested mode — so the harness must write the full envelope
to that root itself.

These tests inject a FAKE Langfuse client (no live server) and assert the harness
root observation's ``output`` is the full envelope (``behaviorClass``, ``answer``,
``claims``), not just ``behaviorClass``. The service client is faked too, so no
network runs.
"""

from __future__ import annotations

from typing import Any

import pytest

from owners_manual_evals.answer_claim import AnswerClaim
from owners_manual_evals.citable_path import CitablePath, CitablePathSegment
from owners_manual_evals.golden_item import AnswerPoint, GoldenItem, Provenance
from owners_manual_evals.live_runner import build_live_answer
from owners_manual_evals.service_client import AnswerResult


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

_CITE2 = CitablePath(
    document_id="rta-2006",
    segments=(
        CitablePathSegment("section", "62"),
        CitablePathSegment("subsection", "1"),
    ),
)

_CLAIM_TEXT = "Landlords must keep the rental unit in a good state of repair."

_CITE_WIRE = {
    "documentId": "rta-2006",
    "segments": [
        {"kind": "part", "label": "III"},
        {"kind": "section", "label": "20"},
        {"kind": "subsection", "label": "1"},
    ],
}

_CITE2_WIRE = {
    "documentId": "rta-2006",
    "segments": [
        {"kind": "section", "label": "62"},
        {"kind": "subsection", "label": "1"},
    ],
}


def _answer_result() -> AnswerResult:
    return AnswerResult(
        trace_id="c" * 32,
        behavior_class="answer",
        candidate_cites=(_CITE,),
        claims=(AnswerClaim(text=_CLAIM_TEXT, cites=(_CITE,)),),
        retrieved_path_keys=("rta-2006|part:III|section:20|subsection:1",),
        corpus_build_hash="a" * 64,
        pipeline_config_hash="f" * 64,
        latency_ms={"total": 950.0},
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
        self.observation_kwargs: dict[str, Any] | None = None

    def create_trace_id(self, *, seed: str) -> str:
        return "c" * 32

    def start_as_current_observation(self, **kwargs: Any) -> _FakeSpan:
        self.observation_kwargs = dict(kwargs)
        return self.span


class _FakeClient:
    """A fake NaiveRagClient: records the call and returns a canned result."""

    def __init__(self, result: AnswerResult) -> None:
        self._result = result
        self.calls: list[dict] = []

    def answer(self, **kwargs: Any) -> AnswerResult:
        self.calls.append(dict(kwargs))
        return self._result


def _build(langfuse: _FakeLangfuse, client: _FakeClient):  # noqa: ANN202
    return build_live_answer(
        service_url="http://svc:8787",
        run_name="naive-rag-v0",
        documents=(),
        langfuse=langfuse,
        client=client,
    )


def test_harness_root_records_the_full_envelope_not_just_behavior() -> None:
    langfuse = _FakeLangfuse()
    client = _FakeClient(_answer_result())
    answer, _ = _build(langfuse, client)

    answer(_item())

    assert len(langfuse.span.outputs) == 1
    output = langfuse.span.outputs[0]
    # The full envelope, not just { behaviorClass }.
    assert set(output) == {"behaviorClass", "answer", "claims"}
    assert output["behaviorClass"] == "answer"
    assert output["answer"] == "The landlord must maintain the unit."


def test_harness_root_claims_carry_text_and_the_cite_wire_shape() -> None:
    """A claim on the root must be a valid envelope claim — ``text`` AND ``cites``
    (the shared ``answerClaimSchema`` requires both), not cites alone."""
    langfuse = _FakeLangfuse()
    client = _FakeClient(_answer_result())
    answer, _ = _build(langfuse, client)

    answer(_item())

    claims = langfuse.span.outputs[0]["claims"]
    assert claims == [{"text": _CLAIM_TEXT, "cites": [_CITE_WIRE]}]


def test_harness_root_preserves_claim_grouping_not_one_per_cite() -> None:
    """A single claim citing two sections stays ONE claim entry with both cites —
    the harness must mirror the service's claim objects, never splay one-per-cite."""
    langfuse = _FakeLangfuse()
    result = AnswerResult(
        trace_id="c" * 32,
        behavior_class="answer",
        candidate_cites=(_CITE, _CITE2),
        claims=(AnswerClaim(text=_CLAIM_TEXT, cites=(_CITE, _CITE2)),),
        retrieved_path_keys=(),
        corpus_build_hash="a" * 64,
        pipeline_config_hash="f" * 64,
        latency_ms={"total": 950.0},
        answer_text="The landlord must maintain the unit.",
    )
    answer, _ = _build(langfuse, _FakeClient(result))

    answer(_item())

    claims = langfuse.span.outputs[0]["claims"]
    assert claims == [{"text": _CLAIM_TEXT, "cites": [_CITE_WIRE, _CITE2_WIRE]}]


def test_injected_client_still_nests_the_service_under_the_harness_span() -> None:
    langfuse = _FakeLangfuse()
    client = _FakeClient(_answer_result())
    answer, returned = _build(langfuse, client)

    outcome = answer(_item())

    # The injected client is driven with the harness span id (real nesting).
    assert client.calls[0]["parent_span_id"] == "d" * 16
    assert client.calls[0]["trace_id"] == "c" * 32
    # The seam returns the injected client's Langfuse so the score sink reuses it.
    assert returned is langfuse
    assert outcome.answer_text == "The landlord must maintain the unit."


def test_default_binding_builds_the_real_langfuse_and_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without injection the live default is unchanged: it reaches for the real
    SDK (which raises here because no credentials are configured)."""
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    with pytest.raises(RuntimeError, match="LANGFUSE_PUBLIC_KEY"):
        build_live_answer(
            service_url="http://svc:8787",
            run_name="naive-rag-v0",
            documents=(),
        )
