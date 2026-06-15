"""HTTP client for the stuffing-arm routes ``/stuff`` and ``/stuff-oracle`` (#18).

The harness drives the TS service as a black box over HTTP (ADR 0003). This client
mirrors :class:`NaiveRagClient`: it POSTs ``{question, itemId, traceId?}`` (plus
``orderSeed`` for the probe, and ``corpora`` for the oracle route) and parses the
response. Trace-id propagation (AC2) is carried belt-and-braces — the trace id in
the body, which the service reuses verbatim, and a W3C ``traceparent`` header so
the service's stuffing spans nest under the harness span.

The parsed :class:`StuffResult` is shaped like :class:`AnswerResult` so the runner
scores all four arms identically, plus the stuffing-specific fields the four-arm
table reports: the stuffed source count, the token usage (with the context-cache
hit), the honest cost-per-question, and the order seed.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .citable_path import CitablePath, parse_citable_path
from .service_client import HttpTransport, _UrllibTransport, build_traceparent


@dataclass(frozen=True, slots=True)
class StuffResult:
    """The parsed stuffing-arm response for one item."""

    trace_id: str | None
    arm: str
    behavior_class: str
    candidate_cites: tuple[CitablePath, ...]
    retrieved_path_keys: tuple[str, ...]
    stuffed_source_count: int
    usage: Mapping[str, float]
    cost_usd: float
    order_seed: int
    corpus_build_hash: str
    pipeline_config_hash: str
    latency_ms: Mapping[str, float]
    #: The produced answer prose — carried for the offline LLM judge (#18).
    answer_text: str = ""


def _parse_candidate_cites(envelope: dict) -> tuple[CitablePath, ...]:
    cites: list[CitablePath] = []
    for claim in envelope.get("claims", []):
        for cite in claim.get("cites", []):
            cites.append(parse_citable_path(cite))
    return tuple(cites)


def _parse_response(response: dict) -> StuffResult:
    envelope = response["envelope"]
    run_record = response["runRecord"]
    return StuffResult(
        trace_id=response.get("traceId"),
        arm=response.get("arm", "stuff"),
        behavior_class=envelope["behaviorClass"],
        candidate_cites=_parse_candidate_cites(envelope),
        retrieved_path_keys=tuple(response.get("retrievedCitablePathKeys", [])),
        stuffed_source_count=int(response.get("stuffedSourceCount", 0)),
        usage=response.get("usage", {}),
        cost_usd=float(response.get("costUsd", 0.0)),
        order_seed=int(response.get("orderSeed", 0)),
        corpus_build_hash=run_record["corpusBuildHash"],
        pipeline_config_hash=run_record["pipelineConfigHash"],
        latency_ms=response.get("latencyMs", {}),
        answer_text=str(envelope.get("answer", "")),
    )


class StuffClient:
    """A thin client over the service's ``/stuff`` and ``/stuff-oracle`` routes."""

    def __init__(self, *, base_url: str, transport: HttpTransport | None = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._transport = transport or _UrllibTransport()

    def _post(
        self, path: str, body: dict, trace_id: str | None, parent_span_id: str | None
    ) -> dict:
        headers: dict[str, str] = {}
        if trace_id is not None:
            body["traceId"] = trace_id
        if trace_id is not None and parent_span_id is not None:
            headers["traceparent"] = build_traceparent(trace_id=trace_id, span_id=parent_span_id)
        return self._transport.post_json(f"{self._base_url}{path}", body, headers)

    def stuff(
        self,
        *,
        question: str,
        item_id: str,
        trace_id: str | None = None,
        parent_span_id: str | None = None,
        order_seed: int | None = None,
    ) -> StuffResult:
        """POST one question to the honest no-RAG ``/stuff`` arm."""
        body: dict = {"question": question, "itemId": item_id}
        if order_seed is not None:
            body["orderSeed"] = order_seed
        return _parse_response(self._post("/stuff", body, trace_id, parent_span_id))

    def stuff_oracle(
        self,
        *,
        question: str,
        item_id: str,
        corpora: Sequence[str],
        trace_id: str | None = None,
        parent_span_id: str | None = None,
        order_seed: int | None = None,
    ) -> StuffResult:
        """POST one question to the corpus-routed ``/stuff-oracle`` arm."""
        body: dict = {"question": question, "itemId": item_id, "corpora": list(corpora)}
        if order_seed is not None:
            body["orderSeed"] = order_seed
        return _parse_response(self._post("/stuff-oracle", body, trace_id, parent_span_id))


__all__ = ["StuffClient", "StuffResult"]
