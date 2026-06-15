"""HTTP client for the naive-rag TS service (issue #10).

The harness treats the TS service as a black box over HTTP (evals/README). This
client POSTs ``{question, itemId, traceId?}`` to ``/answer`` and parses the
response. Trace-id propagation (AC2) is carried two ways, belt and braces:

* the trace id in the request **body**, which the service reuses verbatim as its
  Langfuse trace id, and
* a W3C ``traceparent`` header naming the harness's parent span, so the service
  spans nest under the harness span in one trace.

The HTTP transport is a small injectable protocol so the suite runs offline; the
live transport uses ``urllib`` from the stdlib (no new dependency).
"""

from __future__ import annotations

import json
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

from .citable_path import CitablePath, parse_citable_path


class HttpTransport(Protocol):
    """The slice of an HTTP client this module needs — injectable for tests."""

    def post_json(self, url: str, body: dict, headers: dict[str, str]) -> dict: ...


class _UrllibTransport:
    """Live transport over the stdlib ``urllib`` (no third-party dependency)."""

    def __init__(self, timeout_s: float = 120.0) -> None:
        self._timeout_s = timeout_s

    def post_json(self, url: str, body: dict, headers: dict[str, str]) -> dict:
        data = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(  # noqa: S310 — fixed localhost service URL
            url,
            data=data,
            headers={"content-type": "application/json", **headers},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self._timeout_s) as response:  # noqa: S310
            return json.loads(response.read().decode("utf-8"))


def build_traceparent(*, trace_id: str, span_id: str) -> str:
    """A W3C ``traceparent``: ``00-<32hex trace>-<16hex span>-01`` (sampled)."""
    return f"00-{trace_id}-{span_id}-01"


@dataclass(frozen=True, slots=True)
class AnswerResult:
    """The parsed naive-rag response for one item."""

    trace_id: str | None
    behavior_class: str
    candidate_cites: tuple[CitablePath, ...]
    retrieved_path_keys: tuple[str, ...]
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


class NaiveRagClient:
    """A thin client over the naive-rag service's ``/answer`` endpoint."""

    def __init__(self, *, base_url: str, transport: HttpTransport | None = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._transport = transport or _UrllibTransport()

    def answer(
        self,
        *,
        question: str,
        item_id: str,
        trace_id: str | None = None,
        parent_span_id: str | None = None,
    ) -> AnswerResult:
        """POST one question; propagate the trace id; parse the response."""
        body: dict = {"question": question, "itemId": item_id}
        if trace_id is not None:
            body["traceId"] = trace_id
        headers: dict[str, str] = {}
        if trace_id is not None and parent_span_id is not None:
            headers["traceparent"] = build_traceparent(trace_id=trace_id, span_id=parent_span_id)

        response = self._transport.post_json(f"{self._base_url}/answer", body, headers)
        envelope = response["envelope"]
        run_record = response["runRecord"]
        return AnswerResult(
            trace_id=response.get("traceId"),
            behavior_class=envelope["behaviorClass"],
            candidate_cites=_parse_candidate_cites(envelope),
            retrieved_path_keys=tuple(response.get("retrievedCitablePathKeys", [])),
            corpus_build_hash=run_record["corpusBuildHash"],
            pipeline_config_hash=run_record["pipelineConfigHash"],
            latency_ms=response.get("latencyMs", {}),
            answer_text=str(envelope.get("answer", "")),
        )


__all__ = ["HttpTransport", "NaiveRagClient", "AnswerResult", "build_traceparent"]
