"""The disposition domain (issue #21): the verdict every failed item receives.

CONTEXT.md ("Disposition"): the one-line verdict every FAILED item receives
before the next experiment may launch — bug / rubric-wrong / known-limitation /
noise — living in Langfuse as a CATEGORICAL score set from an annotation queue.
This module owns the PURE side, with no Langfuse SDK and no server:

* :data:`DISPOSITIONS` — the closed, canonically-ordered verdict set;
* :data:`DISPOSITION_SCORE_NAME` — the single Langfuse score name a disposition
  is written under (the pre-flight reads dispositions back by this exact name);
* :func:`failed_items_from_scores` — derive the failed items (each carrying the
  trace it sits on, its behavior class, corpus, and the stage that failed) from
  the deterministic :class:`~.metrics.ItemScore`s a run already produced.

A "failed item" is a deterministic strict-pass miss (CONTEXT.md, "Score
dashboard": strict pass is the headline). The FAILING STAGE reuses the existing
retrieval-vs-synthesis split (CONTEXT.md, "Retrieval hit rate": it "splits a
failure into retrieval's fault vs synthesis's fault"): a miss whose required
cites never reached the candidate set is retrieval's fault, otherwise synthesis.
A failure with no trace to join to is DROPPED, not mis-joined — the same orphan
rule :mod:`judge_scores` applies to judge verdicts.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from typing import Literal, get_args

from .golden_item import BehaviorClass, GoldenItem
from .metrics import ItemScore
from .oracle import CORPORA, corpus_of_document_id

#: The closed verdict set every failed item is dispositioned with (CONTEXT.md).
Disposition = Literal["bug", "rubric-wrong", "known-limitation", "noise"]

#: The verdicts in canonical order; the closed set the annotation queue allows.
DISPOSITIONS: tuple[Disposition, ...] = get_args(Disposition)

#: The single Langfuse CATEGORICAL score name a disposition is written under. The
#: pre-flight reads dispositions back by this exact name, so it is pinned here.
DISPOSITION_SCORE_NAME = "disposition"


class FailureStage(Enum):
    """Which stage a strict-pass miss is attributed to (CONTEXT.md, "Retrieval
    hit rate"). One axis of the release digest's stage × behavior × corpus
    clustering."""

    RETRIEVAL = "retrieval"
    SYNTHESIS = "synthesis"


def is_valid_disposition(value: object) -> bool:
    """True iff ``value`` is one of the four closed dispositions."""
    return value in DISPOSITIONS


@dataclass(frozen=True, slots=True)
class FailedItem:
    """One strict-pass miss, with the dimensions the queue and digest need.

    ``trace_id`` is the exact Langfuse trace the item's answer was produced on
    (the annotation-queue item is keyed by it). ``corpus`` and ``stage`` are the
    digest's clustering axes beside ``behavior_class``.
    """

    item_id: str
    trace_id: str
    behavior_class: BehaviorClass
    corpus: str
    stage: FailureStage


def _corpus_of_item(item: GoldenItem) -> str:
    """The corpus a failed item belongs to: the corpus of its required cites
    (CONTEXT.md, oracle routing). A refusal item carries no required cites, so it
    routes to no corpus and is reported under the sentinel ``"none"`` rather than
    raising — a refusal failure is still a failure the digest must show."""
    corpora = {corpus_of_document_id(cite.document_id) for cite in item.required_cites}
    if not corpora:
        return "none"
    # Deterministic when an item spans corpora (cross-corpus item): the first in
    # canonical corpus order, mirroring the oracle's canonical ordering.
    return next(corpus for corpus in CORPORA if corpus in corpora)


def _stage_of(score: ItemScore) -> FailureStage:
    """Retrieval's fault when the required cites never reached the candidate set,
    else synthesis's (CONTEXT.md, "Retrieval hit rate")."""
    if score.retrieval_hit_rate < 1.0:
        return FailureStage.RETRIEVAL
    return FailureStage.SYNTHESIS


def failed_items_from_scores(
    scores: Sequence[ItemScore],
    *,
    items: Mapping[str, GoldenItem],
    trace_ids: Mapping[str, str | None],
) -> tuple[FailedItem, ...]:
    """Derive the failed items (strict-pass misses) from a run's deterministic
    scores, joined to the trace each answer was produced on.

    A score whose item id is absent from ``items`` raises ``KeyError`` rather
    than guessing (a build bug, not a silent skip). A failure whose trace id is
    ``None`` is dropped — an annotation-queue item with no trace is an orphan,
    better dropped than mis-joined.
    """
    failures: list[FailedItem] = []
    for score in scores:
        if score.strict_pass:
            continue
        item = items[score.item_id]  # KeyError on an unknown id — never guess.
        trace_id = trace_ids.get(score.item_id)
        if trace_id is None:
            continue
        failures.append(
            FailedItem(
                item_id=score.item_id,
                trace_id=trace_id,
                behavior_class=item.behavior_class,
                corpus=_corpus_of_item(item),
                stage=_stage_of(score),
            )
        )
    return tuple(failures)


__all__ = [
    "Disposition",
    "DISPOSITIONS",
    "DISPOSITION_SCORE_NAME",
    "FailureStage",
    "FailedItem",
    "is_valid_disposition",
    "failed_items_from_scores",
]
