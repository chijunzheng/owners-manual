"""One answer claim — the assertion text plus the pin-cites that back it.

The Python eval harness parses the TS service's answer envelope (the shared
``answerClaimSchema``: ``{text, cites}``) into typed claims so it can write a
FAITHFUL full envelope to its owned root observation in nested mode (issue #50)
— the same claims the service emitted, NOT a flattened, textless cite list. The
type and its parse live here once so the naive-rag and agent clients share them
(high cohesion; no duplicated claim parse).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .citable_path import CitablePath, parse_citable_path


@dataclass(frozen=True, slots=True)
class AnswerClaim:
    """One claim in an answer: the assertion text and the pin-cites backing it."""

    text: str
    cites: tuple[CitablePath, ...]


def parse_answer_claims(envelope: dict) -> tuple[AnswerClaim, ...]:
    """Parse an answer envelope's claims (text + cites) into typed claims.

    Mirrors the TS ``answerClaimSchema`` ({text, cites}). Refusals carry an empty
    ``claims`` list, which parses to an empty tuple. Claim grouping is preserved —
    one :class:`AnswerClaim` per envelope claim, each keeping all its cites — so a
    consumer never sees claims splayed one-per-cite.
    """
    claims: list[AnswerClaim] = []
    for claim in envelope.get("claims", []):
        cites = tuple(parse_citable_path(cite) for cite in claim.get("cites", []))
        claims.append(AnswerClaim(text=str(claim.get("text", "")), cites=cites))
    return tuple(claims)


def flatten_cites(claims: Sequence[AnswerClaim]) -> tuple[CitablePath, ...]:
    """The candidate cite set (every cite across every claim) the deterministic
    grader scores — flattened in claim order."""
    return tuple(cite for claim in claims for cite in claim.cites)


__all__ = ["AnswerClaim", "parse_answer_claims", "flatten_cites"]
