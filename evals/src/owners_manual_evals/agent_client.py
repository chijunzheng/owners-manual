"""HTTP+SSE client for the agent's ``/chat`` endpoint (issue #15 AC4).

The harness drives the TS service as a black box over HTTP (ADR 0003). The agent
arm streams over Server-Sent Events: many ``token`` frames as synthesis streams,
then one terminal ``result`` frame carrying the structured answer envelope, the
retrieved path keys, the run record, and the degraded flag. This client mirrors
:class:`NaiveRagClient`'s trace-id propagation (belt and braces — body trace id
plus a W3C ``traceparent`` header) but reads an event STREAM rather than one JSON
body, parsing the terminal ``result`` (or surfacing an ``error``) into a typed
result the runner scores exactly like the naive-rag result.

The streaming transport is a small injectable protocol so the suite runs offline;
the live transport uses ``urllib`` from the stdlib (no new dependency).
"""

from __future__ import annotations

import json
import urllib.request
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Protocol

from .citable_path import CitablePath, parse_citable_path
from .service_client import build_traceparent


class SseTransport(Protocol):
    """The slice of a streaming HTTP client this module needs — injectable.

    ``stream_sse`` POSTs ``body`` and yields the response body's raw text lines
    (SSE frames are newline-delimited ``field: value`` lines with blank-line
    separators), so the parser is identical for the live and fake transports.
    """

    def stream_sse(self, url: str, body: dict, headers: dict[str, str]) -> Iterable[str]: ...


class _UrllibSseTransport:
    """Live SSE transport over the stdlib ``urllib`` (no third-party dependency)."""

    def __init__(self, timeout_s: float = 180.0) -> None:
        self._timeout_s = timeout_s

    def stream_sse(self, url: str, body: dict, headers: dict[str, str]) -> Iterable[str]:
        data = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(  # noqa: S310 — fixed localhost service URL
            url,
            data=data,
            headers={
                "content-type": "application/json",
                "accept": "text/event-stream",
                **headers,
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self._timeout_s) as response:  # noqa: S310
            for raw in response:
                yield raw.decode("utf-8").rstrip("\n")


@dataclass(frozen=True, slots=True)
class ChatResult:
    """The parsed agent ``/chat`` response for one item.

    Shaped like :class:`AnswerResult` so the runner scores both arms identically;
    adds ``degraded`` (the Critic stayed ungrounded at the re-retrieval cap) and
    ``tokens`` (the streamed prose chunks, kept so a smoke run can assert the
    stream actually flowed).
    """

    trace_id: str | None
    behavior_class: str
    candidate_cites: tuple[CitablePath, ...]
    retrieved_path_keys: tuple[str, ...]
    corpus_build_hash: str
    pipeline_config_hash: str
    latency_ms: Mapping[str, float]
    degraded: bool
    tokens: tuple[str, ...] = field(default=())


def _parse_candidate_cites(envelope: dict) -> tuple[CitablePath, ...]:
    cites: list[CitablePath] = []
    for claim in envelope.get("claims", []):
        for cite in claim.get("cites", []):
            cites.append(parse_citable_path(cite))
    return tuple(cites)


def parse_sse_events(lines: Iterable[str]) -> Iterable[dict]:
    """Parse SSE wire lines into event payloads (the JSON ``data:`` of each frame).

    A frame is one or more ``field: value`` lines terminated by a blank line; we
    only need the ``data:`` field (the service puts the whole event JSON there).
    Concatenates multi-line ``data:`` per the SSE spec, then yields the decoded
    object. Malformed JSON in a data line is skipped rather than crashing the
    stream — a single bad frame must not lose the terminal result.
    """
    data_parts: list[str] = []
    for line in lines:
        if line == "":
            if data_parts:
                payload = "\n".join(data_parts)
                data_parts = []
                try:
                    yield json.loads(payload)
                except json.JSONDecodeError:
                    continue
            continue
        if line.startswith(":"):
            continue  # an SSE comment / heartbeat
        field_name, _, value = line.partition(":")
        if field_name == "data":
            data_parts.append(value[1:] if value.startswith(" ") else value)
    # A final frame not followed by a blank line (stream closed) still counts.
    if data_parts:
        payload = "\n".join(data_parts)
        try:
            yield json.loads(payload)
        except json.JSONDecodeError:
            return


class AgentChatClient:
    """A thin client over the agent service's streaming ``/chat`` endpoint."""

    def __init__(self, *, base_url: str, transport: SseTransport | None = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._transport = transport or _UrllibSseTransport()

    def chat(
        self,
        *,
        question: str,
        item_id: str,
        trace_id: str | None = None,
        parent_span_id: str | None = None,
    ) -> ChatResult:
        """POST one question; stream the SSE; parse the terminal ``result``.

        Raises ``RuntimeError`` if the stream ends with an ``error`` frame or
        without a terminal ``result`` — a black-box failure the runner surfaces
        rather than scoring a phantom answer.
        """
        body: dict = {"question": question, "itemId": item_id}
        if trace_id is not None:
            body["traceId"] = trace_id
        headers: dict[str, str] = {}
        if trace_id is not None and parent_span_id is not None:
            headers["traceparent"] = build_traceparent(trace_id=trace_id, span_id=parent_span_id)

        tokens: list[str] = []
        result_event: dict | None = None
        for event in parse_sse_events(
            self._transport.stream_sse(f"{self._base_url}/chat", body, headers)
        ):
            kind = event.get("type")
            if kind == "token":
                tokens.append(str(event.get("token", "")))
            elif kind == "result":
                result_event = event
            elif kind == "error":
                raise RuntimeError(f"agent /chat returned an error: {event.get('message')}")

        if result_event is None:
            raise RuntimeError("agent /chat stream ended without a terminal result event")

        envelope = result_event["envelope"]
        run_record = result_event["runRecord"]
        return ChatResult(
            trace_id=result_event.get("traceId"),
            behavior_class=envelope["behaviorClass"],
            candidate_cites=_parse_candidate_cites(envelope),
            retrieved_path_keys=tuple(result_event.get("retrievedCitablePathKeys", [])),
            corpus_build_hash=run_record["corpusBuildHash"],
            pipeline_config_hash=run_record["pipelineConfigHash"],
            latency_ms=result_event.get("latencyMs", {}),
            degraded=bool(result_event.get("degraded", False)),
            tokens=tuple(tokens),
        )


__all__ = [
    "SseTransport",
    "AgentChatClient",
    "ChatResult",
    "parse_sse_events",
]
