"""Disposition domain tests (issue #21).

A disposition (CONTEXT.md, "Disposition") is the one-line verdict every FAILED
item receives before the next experiment may launch: bug / rubric-wrong /
known-limitation / noise. It lives in Langfuse as a CATEGORICAL score; this
module owns the PURE side — the closed verdict set, the score name the
disposition is written under, and deriving the failed items (with the trace they
sit on, their behavior class, corpus, and failing stage) from the deterministic
item scores a run already produced.

A "failed item" is a deterministic strict-pass miss (CONTEXT.md, "Score
dashboard": strict pass is the headline). No Langfuse server is touched here.
"""

from __future__ import annotations

import pytest

from owners_manual_evals.citable_path import CitablePath, CitablePathSegment
from owners_manual_evals.disposition import (
    DISPOSITION_SCORE_NAME,
    DISPOSITIONS,
    FailedItem,
    FailureStage,
    failed_items_from_scores,
    is_valid_disposition,
)
from owners_manual_evals.golden_item import AnswerPoint, GoldenItem, Provenance
from owners_manual_evals.metrics import ItemScore


def _item(item_id: str, *, document_id: str = "rta-2006") -> GoldenItem:
    return GoldenItem(
        id=item_id,
        behavior_class="answer",
        verified=True,
        question="q?",
        answer_points=(AnswerPoint(id="p", text="t"),),
        required_cites=(
            CitablePath(
                document_id=document_id,
                segments=(CitablePathSegment("section", "1"),),
            ),
        ),
        provenance=Provenance(source="x", reference="y"),
    )


def _score(
    item_id: str,
    *,
    behavior_match: bool,
    cite_recall: float,
    retrieval_hit_rate: float,
    strict_pass: bool,
    behavior_class: str = "answer",
) -> ItemScore:
    return ItemScore(
        item_id=item_id,
        behavior_class=behavior_class,  # type: ignore[arg-type]
        behavior_match=behavior_match,
        cite_precision=1.0,
        cite_recall=cite_recall,
        retrieval_hit_rate=retrieval_hit_rate,
        strict_pass=strict_pass,
    )


def test_the_four_dispositions_are_the_closed_categorical_set() -> None:
    # CONTEXT.md names exactly these four, in this order — no triage-label drift.
    assert DISPOSITIONS == ("bug", "rubric-wrong", "known-limitation", "noise")
    assert all(is_valid_disposition(value) for value in DISPOSITIONS)
    assert not is_valid_disposition("todo")
    assert not is_valid_disposition("")


def test_disposition_is_written_under_a_stable_categorical_score_name() -> None:
    # The pre-flight reads dispositions back by this exact name; pin it.
    assert DISPOSITION_SCORE_NAME == "disposition"


def test_only_strict_pass_misses_become_failed_items() -> None:
    scores = (
        _score(
            "pass-1", behavior_match=True, cite_recall=1.0, retrieval_hit_rate=1.0, strict_pass=True
        ),
        _score(
            "fail-1",
            behavior_match=True,
            cite_recall=0.5,
            retrieval_hit_rate=1.0,
            strict_pass=False,
        ),
    )
    trace_ids = {"pass-1": "a" * 32, "fail-1": "b" * 32}

    failures = failed_items_from_scores(
        scores, items={i: _item(i) for i in trace_ids}, trace_ids=trace_ids
    )

    assert tuple(f.item_id for f in failures) == ("fail-1",)
    assert failures[0].trace_id == "b" * 32


def test_failed_item_carries_trace_behavior_class_and_corpus() -> None:
    scores = (
        _score(
            "fail-1",
            behavior_match=False,
            cite_recall=1.0,
            retrieval_hit_rate=1.0,
            strict_pass=False,
        ),
    )
    failures = failed_items_from_scores(
        scores,
        items={"fail-1": _item("fail-1", document_id="rta-2006")},
        trace_ids={"fail-1": "c" * 32},
    )

    failure = failures[0]
    assert isinstance(failure, FailedItem)
    assert failure.behavior_class == "answer"
    assert failure.corpus == "tenancy"  # rta-2006 -> tenancy (oracle map)


def test_stage_is_retrieval_when_required_cites_never_reached() -> None:
    # retrieval_hit_rate < 1.0 ⇒ retrieval's fault (CONTEXT.md, "Retrieval hit rate").
    scores = (
        _score(
            "fail-r",
            behavior_match=True,
            cite_recall=0.0,
            retrieval_hit_rate=0.0,
            strict_pass=False,
        ),
    )
    failures = failed_items_from_scores(
        scores, items={"fail-r": _item("fail-r")}, trace_ids={"fail-r": "d" * 32}
    )
    assert failures[0].stage is FailureStage.RETRIEVAL


def test_stage_is_synthesis_when_retrieval_reached_but_answer_still_failed() -> None:
    # The cites were retrievable (hit rate 1.0) yet strict pass missed: synthesis.
    scores = (
        _score(
            "fail-s",
            behavior_match=True,
            cite_recall=0.5,
            retrieval_hit_rate=1.0,
            strict_pass=False,
        ),
    )
    failures = failed_items_from_scores(
        scores, items={"fail-s": _item("fail-s")}, trace_ids={"fail-s": "e" * 32}
    )
    assert failures[0].stage is FailureStage.SYNTHESIS


def test_a_failure_with_no_trace_to_join_to_is_dropped_not_misjoined() -> None:
    # Mirror judge_scores: an annotation-queue item with no trace is an orphan,
    # better dropped than enqueued against a wrong (or missing) trace.
    scores = (
        _score(
            "fail-1",
            behavior_match=False,
            cite_recall=1.0,
            retrieval_hit_rate=1.0,
            strict_pass=False,
        ),
    )
    failures = failed_items_from_scores(
        scores, items={"fail-1": _item("fail-1")}, trace_ids={"fail-1": None}
    )
    assert failures == ()


def test_unknown_item_id_in_scores_raises_rather_than_guessing() -> None:
    scores = (
        _score(
            "ghost",
            behavior_match=False,
            cite_recall=1.0,
            retrieval_hit_rate=1.0,
            strict_pass=False,
        ),
    )
    with pytest.raises(KeyError):
        failed_items_from_scores(scores, items={}, trace_ids={"ghost": "f" * 32})
