"""HTTP client for the TS service's retrieval-debug endpoint (#14 AC2/AC4).

ADR 0003 makes ``/retrieve/debug`` part of the contract: it exposes hybrid
retrieval's ranked candidates WITH stage-provenance so the harness (a black-box
HTTP client) can compute the pre-synthesis hit-rate and the hybrid-vs-vector-only
comparison over the FULL corpus — the statute-cite items the offline fixture
corpus can't reach. Reuses the injectable :class:`HttpTransport` from the
naive-rag client, so the suite runs offline against a fake.
"""

from __future__ import annotations

from dataclasses import dataclass

from .service_client import HttpTransport, _UrllibTransport


@dataclass(frozen=True, slots=True)
class DebugCandidate:
    """One candidate from the debug endpoint, with its fusion provenance."""

    document_id: str
    citable_path_key: str
    text: str
    stage: str
    stages: tuple[str, ...]
    stage_ranks: dict[str, int]
    rrf_score: float
    authority_level: str


@dataclass(frozen=True, slots=True)
class DebugResult:
    """The parsed retrieval-debug response for one question."""

    question: str
    query_dimensions: int
    candidates: tuple[DebugCandidate, ...]

    @property
    def retrieved_path_keys(self) -> tuple[str, ...]:
        """Every candidate's path key — the input to the hierarchical hit-rate."""
        return tuple(c.citable_path_key for c in self.candidates)


def _parse_candidate(raw: dict) -> DebugCandidate:
    return DebugCandidate(
        document_id=raw["documentId"],
        citable_path_key=raw["citablePathKey"],
        text=raw.get("text", ""),
        stage=raw["stage"],
        stages=tuple(raw.get("stages", ())),
        stage_ranks={k: int(v) for k, v in raw.get("stageRanks", {}).items()},
        rrf_score=float(raw.get("rrfScore", 0.0)),
        authority_level=raw["authorityLevel"],
    )


class RetrieveDebugClient:
    """A thin client over the service's ``/retrieve/debug`` endpoint."""

    def __init__(self, *, base_url: str, transport: HttpTransport | None = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._transport = transport or _UrllibTransport()

    def retrieve(
        self,
        *,
        question: str,
        top_k: int | None = None,
        mode: str | None = None,
        authority_levels: tuple[str, ...] | None = None,
    ) -> DebugResult:
        """POST one question; parse the ranked candidates with provenance.

        ``mode`` selects ``hybrid`` (default, fused) or ``vector`` (the
        vector-only baseline over the same chunks) so the full-corpus
        hybrid-vs-vector comparison flips one flag, not the chunker.
        """
        body: dict = {"question": question}
        if top_k is not None:
            body["topK"] = top_k
        if mode is not None:
            body["mode"] = mode
        if authority_levels is not None:
            body["authorityLevels"] = list(authority_levels)

        response = self._transport.post_json(f"{self._base_url}/retrieve/debug", body, {})
        return DebugResult(
            question=response.get("question", question),
            query_dimensions=int(response.get("queryDimensions", 0)),
            candidates=tuple(_parse_candidate(c) for c in response.get("candidates", [])),
        )


__all__ = ["DebugCandidate", "DebugResult", "RetrieveDebugClient"]
