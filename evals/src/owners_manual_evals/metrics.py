"""Deterministic scoring for the naive-rag harness (issue #10).

The structured answer envelope makes behavior and cites machine-checkable
without a judge (CONTEXT.md, "Smoke slice"), so this module needs no LLM:

* **Behavior match** — the observed behavior class equals the golden item's.
* **Citation precision / recall** — graded with the SAME hierarchical matcher
  (:func:`match_cite`) as required cites: a candidate that exactly matches, or
  sits strictly below, a required cite satisfies it (descendant-satisfies-
  ancestor). Precision is the fraction of offered cites that land on some
  requirement; recall is the fraction of requirements some offered cite reaches.
* **Strict pass** (CONTEXT.md, "Score dashboard": the headline) — behavior match
  AND every required cite satisfied. Answer-point credit is judge-scored later;
  this slice's strict pass is the deterministic floor.
* **Retrieval hit rate** (CONTEXT.md) — the fraction of required cites whose
  citable paths reached the candidate set, matched hierarchically. Splits a
  failure into retrieval's fault vs synthesis's fault.

Refusal items carry no required cites; their cite P/R is vacuously 1.0 so they
never drag a slice down, and their strict pass rides on behavior alone.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .citable_path import CitablePath, CitablePathSegment
from .cite_matcher import match_cite, satisfies_requirement
from .document_tree import DocumentTree
from .golden_item import BehaviorClass, GoldenItem

#: The segment kinds a stored path key may carry (mirrors core SEGMENT_KINDS).
_SEGMENT_KINDS = frozenset({"document", "part", "section", "subsection", "clause"})


def parse_path_key(key: str) -> CitablePath:
    """Inverse of the TS ``pathKey``: ``documentId|kind:label|…`` → CitablePath.

    Raises ``ValueError`` on a malformed key rather than guessing — a retrieved
    row that cannot be graded is a build bug, not a silent miss.
    """
    document_id, *raw_segments = key.split("|")
    if not document_id:
        raise ValueError(f"malformed path key (no documentId): {key!r}")
    segments: list[CitablePathSegment] = []
    for raw in raw_segments:
        kind, separator, label = raw.partition(":")
        if not separator or kind not in _SEGMENT_KINDS or not label:
            raise ValueError(f"malformed path-key segment {raw!r} in {key!r}")
        segments.append(CitablePathSegment(kind=kind, label=label))
    return CitablePath(document_id=document_id, segments=tuple(segments))


def behavior_matches(observed: str, expected: BehaviorClass) -> bool:
    """True when the observed behavior class equals the golden item's."""
    return observed == expected


@dataclass(frozen=True, slots=True)
class PrecisionRecall:
    """A precision/recall pair over cites, each in ``[0, 1]``."""

    precision: float
    recall: float


def _candidate_satisfies_some_requirement(
    candidate: CitablePath,
    required: Sequence[CitablePath],
    documents: Sequence[DocumentTree],
) -> bool:
    return any(
        satisfies_requirement(match_cite(required=req, candidate=candidate, documents=documents))
        for req in required
    )


def _requirement_satisfied_by_some_candidate(
    requirement: CitablePath,
    candidate: Sequence[CitablePath],
    documents: Sequence[DocumentTree],
) -> bool:
    return any(
        satisfies_requirement(match_cite(required=requirement, candidate=cand, documents=documents))
        for cand in candidate
    )


def cite_precision_recall(
    *,
    required: Sequence[CitablePath],
    candidate: Sequence[CitablePath],
    documents: Sequence[DocumentTree],
) -> PrecisionRecall:
    """Hierarchical citation precision and recall.

    Precision: fraction of offered cites that satisfy some requirement.
    Recall: fraction of requirements satisfied by some offered cite.
    With no requirements and no candidates both are 1.0 (vacuous — refusals).
    """
    precision = (
        1.0
        if not candidate
        else sum(
            _candidate_satisfies_some_requirement(cand, required, documents) for cand in candidate
        )
        / len(candidate)
    )
    recall = (
        1.0
        if not required
        else sum(
            _requirement_satisfied_by_some_candidate(req, candidate, documents) for req in required
        )
        / len(required)
    )
    return PrecisionRecall(precision=precision, recall=recall)


def retrieval_hit_rate(
    *,
    required: Sequence[CitablePath],
    retrieved_path_keys: Sequence[str],
    documents: Sequence[DocumentTree],
) -> float:
    """Fraction of required cites whose paths reached the retrieved candidate
    set, matched hierarchically — counts required cites, not chunks. 1.0 when
    nothing is required (refusals)."""
    if not required:
        return 1.0
    retrieved = tuple(parse_path_key(key) for key in retrieved_path_keys)
    reached = sum(
        _requirement_satisfied_by_some_candidate(req, retrieved, documents) for req in required
    )
    return reached / len(required)


@dataclass(frozen=True, slots=True)
class ItemScore:
    """The deterministic score of one golden item against one observed answer."""

    item_id: str
    behavior_class: BehaviorClass
    behavior_match: bool
    cite_precision: float
    cite_recall: float
    retrieval_hit_rate: float
    strict_pass: bool


def score_item(
    item: GoldenItem,
    *,
    observed_behavior: str,
    candidate_cites: Sequence[CitablePath],
    retrieved_path_keys: Sequence[str],
    documents: Sequence[DocumentTree],
) -> ItemScore:
    """Score one item: behavior match, cite P/R, retrieval hit rate, strict pass.

    Strict pass = behavior match AND every required cite satisfied (recall 1.0).
    """
    match = behavior_matches(observed_behavior, item.behavior_class)
    pr = cite_precision_recall(
        required=item.required_cites, candidate=candidate_cites, documents=documents
    )
    hit_rate = retrieval_hit_rate(
        required=item.required_cites, retrieved_path_keys=retrieved_path_keys, documents=documents
    )
    strict_pass = match and pr.recall == 1.0
    return ItemScore(
        item_id=item.id,
        behavior_class=item.behavior_class,
        behavior_match=match,
        cite_precision=pr.precision,
        cite_recall=pr.recall,
        retrieval_hit_rate=hit_rate,
        strict_pass=strict_pass,
    )


__all__ = [
    "PrecisionRecall",
    "ItemScore",
    "behavior_matches",
    "cite_precision_recall",
    "parse_path_key",
    "retrieval_hit_rate",
    "score_item",
]
