"""Deterministic-metric tests for the naive-rag harness (issue #10).

Pins the metrics the dashboard headlines: behavior match, citation
precision/recall graded with the SAME hierarchical matcher as required cites,
the strict pass rate (behavior + all points present is judge-scored later, but
behavior + all required cites is deterministic here), and retrieval hit rate.

No live network: the metrics take a golden item, the envelope the service
returned (already parsed), and the retrieved path keys. The cite grading reuses
``match_cite`` so a descendant satisfies an ancestor exactly as in cite grading.
"""

from __future__ import annotations

from owners_manual_evals.citable_path import CitablePath, CitablePathSegment
from owners_manual_evals.document_tree import parse_document_tree
from owners_manual_evals.golden_item import parse_golden_item
from owners_manual_evals.metrics import (
    behavior_matches,
    cite_precision_recall,
    retrieval_hit_rate,
    score_item,
)

_RTA_TREE = parse_document_tree(
    {
        "kind": "document",
        "documentId": "rta-2006",
        "label": "RTA",
        "children": [
            {
                "kind": "part",
                "label": "III",
                "children": [
                    {
                        "kind": "section",
                        "label": "20",
                        "children": [
                            {"kind": "subsection", "label": "1", "children": []},
                            {"kind": "subsection", "label": "2", "children": []},
                        ],
                    }
                ],
            },
            {
                "kind": "part",
                "label": "II",
                "children": [{"kind": "section", "label": "14", "children": []}],
            },
        ],
    }
)
_DOCUMENTS = (_RTA_TREE,)


def _path(*segments: tuple[str, str]) -> CitablePath:
    return CitablePath(
        document_id="rta-2006",
        segments=tuple(CitablePathSegment(kind=k, label=label) for k, label in segments),
    )


def _answer_item() -> object:
    return parse_golden_item(
        {
            "id": "answer-repair",
            "behavior_class": "answer",
            "corpus": "tenancy",
            "verified": True,
            "question": "who repairs the unit?",
            "answer_points": [{"id": "p1", "text": "landlord duty"}],
            "required_cites": [
                {
                    "documentId": "rta-2006",
                    "segments": [
                        {"kind": "part", "label": "III"},
                        {"kind": "section", "label": "20"},
                        {"kind": "subsection", "label": "1"},
                    ],
                }
            ],
            "provenance": {"source": "statute", "reference": "RTA s.20"},
        },
        documents=_DOCUMENTS,
    )


def _refusal_item() -> object:
    return parse_golden_item(
        {
            "id": "refuse-bc",
            "behavior_class": "refuse-jurisdiction",
            "corpus": "tenancy",
            "verified": True,
            "question": "BC rent?",
            "answer_points": [{"id": "p1", "text": "ontario only"}],
            "required_cites": [],
            "provenance": {"source": "behavior-design", "reference": "x"},
        },
        documents=_DOCUMENTS,
    )


# --- behavior match --------------------------------------------------------


def test_behavior_matches_when_classes_agree() -> None:
    assert behavior_matches("answer", "answer")


def test_behavior_does_not_match_when_classes_differ() -> None:
    assert not behavior_matches("answer", "refuse-jurisdiction")


# --- citation precision / recall -------------------------------------------


def test_perfect_precision_and_recall_for_an_exact_cite() -> None:
    pr = cite_precision_recall(
        required=(_path(("part", "III"), ("section", "20"), ("subsection", "1")),),
        candidate=(_path(("part", "III"), ("section", "20"), ("subsection", "1")),),
        documents=_DOCUMENTS,
    )
    assert pr.precision == 1.0
    assert pr.recall == 1.0


def test_descendant_satisfies_ancestor_in_recall() -> None:
    # The answer cites the subsection; the requirement is the section — a
    # descendant satisfies its ancestor (hierarchical matcher).
    pr = cite_precision_recall(
        required=(_path(("part", "III"), ("section", "20")),),
        candidate=(_path(("part", "III"), ("section", "20"), ("subsection", "1")),),
        documents=_DOCUMENTS,
    )
    assert pr.recall == 1.0
    assert pr.precision == 1.0


def test_an_irrelevant_cite_lowers_precision_but_not_recall() -> None:
    pr = cite_precision_recall(
        required=(_path(("part", "III"), ("section", "20"), ("subsection", "1")),),
        candidate=(
            _path(("part", "III"), ("section", "20"), ("subsection", "1")),
            _path(("part", "II"), ("section", "14")),
        ),
        documents=_DOCUMENTS,
    )
    assert pr.recall == 1.0
    assert pr.precision == 0.5


def test_a_missing_cite_lowers_recall() -> None:
    pr = cite_precision_recall(
        required=(
            _path(("part", "III"), ("section", "20"), ("subsection", "1")),
            _path(("part", "II"), ("section", "14")),
        ),
        candidate=(_path(("part", "III"), ("section", "20"), ("subsection", "1")),),
        documents=_DOCUMENTS,
    )
    assert pr.recall == 0.5
    assert pr.precision == 1.0


def test_precision_recall_are_one_for_a_refusal_with_no_cites() -> None:
    # Vacuously perfect: no cites required, none offered. Refusals are graded on
    # behavior, and their cite P/R must not drag a slice down.
    pr = cite_precision_recall(required=(), candidate=(), documents=_DOCUMENTS)
    assert pr.precision == 1.0
    assert pr.recall == 1.0


# --- retrieval hit rate ----------------------------------------------------


def test_retrieval_hit_rate_counts_required_cites_reached() -> None:
    rate = retrieval_hit_rate(
        required=(_path(("part", "III"), ("section", "20"), ("subsection", "1")),),
        retrieved_path_keys=("rta-2006|part:III|section:20|subsection:1",),
        documents=_DOCUMENTS,
    )
    assert rate == 1.0


def test_retrieval_hit_rate_is_hierarchical() -> None:
    # The required subsection is reached by retrieving the subsection itself.
    rate = retrieval_hit_rate(
        required=(_path(("part", "III"), ("section", "20"), ("subsection", "1")),),
        retrieved_path_keys=("rta-2006|part:III|section:20|subsection:2",),
        documents=_DOCUMENTS,
    )
    assert rate == 0.0


# --- whole-item scoring ----------------------------------------------------


def test_strict_pass_requires_behavior_and_all_required_cites() -> None:
    item = _answer_item()
    score = score_item(
        item,
        observed_behavior="answer",
        candidate_cites=(_path(("part", "III"), ("section", "20"), ("subsection", "1")),),
        retrieved_path_keys=("rta-2006|part:III|section:20|subsection:1",),
        documents=_DOCUMENTS,
    )
    assert score.behavior_match
    assert score.cite_recall == 1.0
    assert score.strict_pass


def test_strict_pass_fails_when_a_required_cite_is_missing() -> None:
    item = _answer_item()
    score = score_item(
        item,
        observed_behavior="answer",
        candidate_cites=(),
        retrieved_path_keys=(),
        documents=_DOCUMENTS,
    )
    assert score.behavior_match
    assert not score.strict_pass


def test_strict_pass_fails_when_behavior_is_wrong() -> None:
    item = _answer_item()
    score = score_item(
        item,
        observed_behavior="refuse-out-of-scope",
        candidate_cites=(_path(("part", "III"), ("section", "20"), ("subsection", "1")),),
        retrieved_path_keys=("rta-2006|part:III|section:20|subsection:1",),
        documents=_DOCUMENTS,
    )
    assert not score.strict_pass


def test_refusal_item_passes_strictly_on_behavior_alone() -> None:
    item = _refusal_item()
    score = score_item(
        item,
        observed_behavior="refuse-jurisdiction",
        candidate_cites=(),
        retrieved_path_keys=(),
        documents=_DOCUMENTS,
    )
    assert score.strict_pass
    assert score.cite_precision == 1.0
