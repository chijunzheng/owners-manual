"""Per-stage rescue stats (#16 AC1): which required cites each retrieval stage
reached — and which it rescued ALONE.

CONTEXT.md ("Retrieval hit rate") asks for component value as MECHANISM, not just
outcome: each candidate carries stage-provenance tags (vector / bm25 /
graph-expansion / rerank-survivor), so the harness can report "graph expansion
rescued N required cites nothing else reached". This module computes exactly that
from the per-item required cites and the per-item retrieved candidates' stage
tags, hierarchically matched with the SAME matcher (:func:`match_cite`) as cite
grading — so a rescue counts a *required cite*, never a chunk.

Two numbers per stage:
  * ``reached`` — required cites that some candidate carrying this stage reached;
  * ``rescued_only`` — required cites reached via this stage and NO other stage
    (the headline "found only by graph expansion" number #23 reads).

A required cite reached by two stages is rescued-only by neither — that is the
redundancy signal. Refusal items (no required cites) contribute nothing. Like
every dashboard here: each stage in its own row, no blended scalar, slices never
collapsed (CONTEXT.md, "Score dashboard").
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .citable_path import CitablePath
from .cite_matcher import match_cite, satisfies_requirement
from .document_tree import DocumentTree
from .metrics import parse_path_key

#: The retrieval stages reported, in a stable display order. Mirrors the TS
#: ``RetrievalStage`` union (minus ``stuffed``, which is the no-retrieval arm).
RESCUE_STAGES: tuple[str, ...] = (
    "vector",
    "bm25",
    "hybrid",
    "graph-expansion",
    "rerank-survivor",
)


@dataclass(frozen=True, slots=True)
class StageCandidate:
    """One retrieved candidate: its citable-path key and the stages that surfaced it."""

    citable_path_key: str
    stages: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class StageRescueRow:
    """One stage's rescue stats: cites it reached and cites it rescued ALONE."""

    stage: str
    #: required cites some candidate carrying this stage reached (hierarchical).
    reached: int
    #: required cites reached via this stage and NO other stage.
    rescued_only: int


@dataclass(frozen=True, slots=True)
class RescueStats:
    """Per-stage rescue rows, in :data:`RESCUE_STAGES` order then any extra stage."""

    rows: tuple[StageRescueRow, ...]


def _candidate_reaches(
    candidate_key: str,
    requirement: CitablePath,
    documents: Sequence[DocumentTree],
) -> bool:
    """True when a candidate's path satisfies a required cite (exact or descendant)."""
    candidate = parse_path_key(candidate_key)
    return satisfies_requirement(
        match_cite(required=requirement, candidate=candidate, documents=documents)
    )


def _stages_that_reached(
    requirement: CitablePath,
    candidates: Sequence[StageCandidate],
    documents: Sequence[DocumentTree],
) -> set[str]:
    """The set of stages whose candidates reached a given required cite."""
    reached: set[str] = set()
    for candidate in candidates:
        if _candidate_reaches(candidate.citable_path_key, requirement, documents):
            reached.update(candidate.stages)
    return reached


def _ordered_stages(present: set[str]) -> list[str]:
    """RESCUE_STAGES order first, then any extra stage sorted (deterministic)."""
    ordered = [stage for stage in RESCUE_STAGES if stage in present]
    extra = sorted(stage for stage in present if stage not in RESCUE_STAGES)
    return [*ordered, *extra]


def build_rescue_stats(
    *,
    required: Sequence[CitablePath],
    candidates: Sequence[StageCandidate],
    documents: Sequence[DocumentTree],
) -> RescueStats:
    """Build per-stage rescue stats for ONE item.

    For each required cite, find the set of stages that reached it; credit
    ``reached`` to each such stage and ``rescued_only`` to the stage that reached
    it alone (a singleton set). A refusal item (no required cites) yields all-zero
    rows. Every stage present on any candidate gets a row, plus the canonical
    :data:`RESCUE_STAGES` so a stage that rescued nothing still shows a zero.
    """
    present = {stage for candidate in candidates for stage in candidate.stages}
    present.update(RESCUE_STAGES)

    reached_count = dict.fromkeys(present, 0)
    rescued_only_count = dict.fromkeys(present, 0)

    for requirement in required:
        stages = _stages_that_reached(requirement, candidates, documents)
        for stage in stages:
            reached_count[stage] += 1
        if len(stages) == 1:
            (sole,) = tuple(stages)
            rescued_only_count[sole] += 1

    rows = tuple(
        StageRescueRow(
            stage=stage,
            reached=reached_count[stage],
            rescued_only=rescued_only_count[stage],
        )
        for stage in _ordered_stages(present)
    )
    return RescueStats(rows=rows)


def aggregate_rescue_stats(per_item: Sequence[RescueStats]) -> RescueStats:
    """Sum per-item rescue stats across items, stage by stage.

    The across-items view #23 reads: e.g. the total required cites graph expansion
    rescued ALONE over the whole golden set. Stages are unioned across items and
    emitted in the canonical order.
    """
    reached: dict[str, int] = {}
    rescued_only: dict[str, int] = {}
    for stats in per_item:
        for row in stats.rows:
            reached[row.stage] = reached.get(row.stage, 0) + row.reached
            rescued_only[row.stage] = rescued_only.get(row.stage, 0) + row.rescued_only

    present = set(reached) | set(rescued_only) | set(RESCUE_STAGES)
    rows = tuple(
        StageRescueRow(
            stage=stage,
            reached=reached.get(stage, 0),
            rescued_only=rescued_only.get(stage, 0),
        )
        for stage in _ordered_stages(present)
    )
    return RescueStats(rows=rows)


def render_rescue_stats(stats: RescueStats, *, run_name: str) -> str:
    """Render the per-stage rescue table: each stage's reached and rescued-only
    counts. Honest by construction — a stage that rescued nothing alone shows 0,
    and there is no single blended number (CONTEXT.md: never one overall scalar)."""
    header = f"{'stage':<18}{'reached':>9}  {'rescued only':>13}"
    lines = [
        f"=== {run_name} — per-stage required-cite rescue ===",
        "",
        "Per retrieval stage: required cites it reached, and required cites it "
        "rescued ALONE (no other stage reached them). 'rescued only' is the "
        "mechanism number — which cites a component contributed that nothing else "
        "did. Each stage stands in its own row; stages are never collapsed.",
        "",
        header,
        "-" * len(header),
    ]
    for row in stats.rows:
        lines.append(f"{row.stage:<18}{row.reached:>9}  {row.rescued_only:>13}")
    return "\n".join(lines)


__all__ = [
    "RESCUE_STAGES",
    "StageCandidate",
    "StageRescueRow",
    "RescueStats",
    "build_rescue_stats",
    "aggregate_rescue_stats",
    "render_rescue_stats",
]
