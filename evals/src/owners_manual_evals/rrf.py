"""Reciprocal Rank Fusion — the offline comparison's rank-only fusion (#14).

Mirror of ``packages/pipeline/src/rrf.ts``. Combines the vector and BM25
rankings into one order using each candidate's RANK in each list (the fused
score of an id is the sum over its lists of ``1 / (k + rank)``, rank 1-based),
so the two incommensurable score scales never need normalizing. ``k`` defaults
to 60 (Cormack et al.). Each fused entry keeps its per-stage ranks so the
comparison can attribute a rescued cite to the stage that found it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

#: The standard RRF damping constant (Cormack et al.).
RRF_K_DEFAULT = 60


@dataclass(frozen=True, slots=True)
class RankedList:
    """One ranked list from a single retrieval stage, best-first (index 0 == rank 1)."""

    stage: str
    ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class FusedCandidate:
    """A fused candidate: its id, RRF score, and the rank each stage gave it."""

    id: str
    rrf_score: float
    ranks: dict[str, int] = field(default_factory=dict)


def fuse_by_rrf(
    lists: Sequence[RankedList],
    *,
    k: int = RRF_K_DEFAULT,
) -> tuple[FusedCandidate, ...]:
    """Fuse ranked lists by RRF.

    Returns the union of all ids, each with its summed RRF score and per-stage
    ranks, ordered by descending score (ties broken by id). Empty lists
    contribute nothing.
    """
    scores: dict[str, float] = {}
    ranks: dict[str, dict[str, int]] = {}

    for ranked in lists:
        for index, identifier in enumerate(ranked.ids):
            rank = index + 1
            scores[identifier] = scores.get(identifier, 0.0) + 1 / (k + rank)
            ranks.setdefault(identifier, {})[ranked.stage] = rank

    fused = [
        FusedCandidate(id=identifier, rrf_score=score, ranks=ranks[identifier])
        for identifier, score in scores.items()
    ]
    fused.sort(key=lambda f: (-f.rrf_score, f.id))
    return tuple(fused)


__all__ = ["RRF_K_DEFAULT", "RankedList", "FusedCandidate", "fuse_by_rrf"]
