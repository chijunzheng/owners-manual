"""Schema-and-validation tests for a single golden item.

Pins the strict parser ``parse_golden_item``: it rejects malformed input rather
than coercing it (matching ``document_tree.py``'s philosophy), resolves every
required cite against the supplied document trees with cite-matcher semantics,
and represents all five behavior classes.

Covers issue #30 acceptance criteria 1, 2, and 3.
"""

import copy
from dataclasses import FrozenInstanceError

import pytest

from owners_manual_evals.cite_matcher import resolves_to_node
from owners_manual_evals.document_tree import parse_document_tree
from owners_manual_evals.golden_item import (
    BEHAVIOR_CLASSES,
    CORPORA,
    GoldenItem,
    parse_golden_item,
)

_RTA_TREE = {
    "kind": "document",
    "documentId": "RTA",
    "label": "RTA",
    "children": [
        {
            "kind": "section",
            "label": "49",
            "children": [
                {
                    "kind": "subsection",
                    "label": "1",
                    "children": [{"kind": "clause", "label": "a", "children": []}],
                }
            ],
        },
        {"kind": "section", "label": "37", "children": []},
    ],
}

_DOCUMENTS = (parse_document_tree(_RTA_TREE),)


def _answer_item() -> dict:
    return {
        "id": "item-answer",
        "behavior_class": "answer",
        "corpus": "tenancy",
        "verified": False,
        "question": "How much notice?",
        "answer_points": [
            {"id": "p1", "text": "A landlord may end the tenancy."},
        ],
        "required_cites": [
            {"documentId": "RTA", "segments": [{"kind": "section", "label": "49"}]},
        ],
        "provenance": {
            "source": "ltb-interpretation-guideline",
            "reference": "LTB Guideline 12 (unverified)",
        },
    }


def _refusal_item() -> dict:
    return {
        "id": "item-refuse",
        "behavior_class": "refuse-jurisdiction",
        "corpus": "tenancy",
        "verified": False,
        "question": "BC rent increase?",
        "answer_points": [{"id": "p1", "text": "Ontario only."}],
        "required_cites": [],
        "provenance": {"source": "adversarial-design", "reference": "BC trap (unverified)"},
    }


# --- happy path ------------------------------------------------------------


def test_parses_a_well_formed_answer_item() -> None:
    item = parse_golden_item(_answer_item(), documents=_DOCUMENTS)
    assert isinstance(item, GoldenItem)
    assert item.id == "item-answer"
    assert item.behavior_class == "answer"
    assert item.verified is False
    assert item.paraphrase_of is None
    assert [p.id for p in item.answer_points] == ["p1"]
    assert len(item.required_cites) == 1
    # every required cite resolved against the supplied trees at parse time
    assert all(resolves_to_node(cite, _DOCUMENTS) for cite in item.required_cites)


def test_all_five_behavior_classes_are_representable() -> None:
    assert set(BEHAVIOR_CLASSES) == {
        "answer",
        "refuse-jurisdiction",
        "refuse-out-of-scope",
        "refuse-advice-escalate",
        "flag-void-clause",
    }
    for behavior_class in BEHAVIOR_CLASSES:
        raw = _refusal_item()
        raw["id"] = f"item-{behavior_class}"
        raw["behavior_class"] = behavior_class
        if behavior_class in ("answer", "flag-void-clause"):
            raw["required_cites"] = [
                {"documentId": "RTA", "segments": [{"kind": "section", "label": "37"}]}
            ]
        item = parse_golden_item(raw, documents=_DOCUMENTS)
        assert item.behavior_class == behavior_class


def test_a_paraphrase_variant_records_its_parent_id() -> None:
    raw = _answer_item()
    raw["id"] = "item-answer-paraphrase"
    raw["paraphrase_of"] = "item-answer"
    item = parse_golden_item(raw, documents=_DOCUMENTS)
    assert item.paraphrase_of == "item-answer"


def test_an_item_is_immutable() -> None:
    item = parse_golden_item(_answer_item(), documents=_DOCUMENTS)
    with pytest.raises(FrozenInstanceError):
        item.behavior_class = "refuse-jurisdiction"  # type: ignore[misc]


# --- corpus: the dashboard slice and split stratum key (#22) ---------------


def test_all_five_corpora_are_representable() -> None:
    assert set(CORPORA) == {
        "tenancy",
        "insurance",
        "governing",
        "selling",
        "cross-corpus",
    }


def test_corpus_is_recorded_on_the_item() -> None:
    raw = _answer_item()
    raw["corpus"] = "insurance"
    item = parse_golden_item(raw, documents=_DOCUMENTS)
    assert item.corpus == "insurance"


def test_rejects_a_missing_corpus() -> None:
    raw = _answer_item()
    del raw["corpus"]
    with pytest.raises(ValueError, match="corpus"):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_rejects_an_unknown_corpus() -> None:
    raw = _answer_item()
    raw["corpus"] = "parking"
    with pytest.raises(ValueError, match="corpus"):
        parse_golden_item(raw, documents=_DOCUMENTS)


# --- AC 1: required cites must resolve against the provided tree -----------


def test_rejects_an_item_whose_required_cite_does_not_resolve() -> None:
    raw = _answer_item()
    raw["required_cites"] = [
        {"documentId": "RTA", "segments": [{"kind": "section", "label": "999"}]}
    ]
    with pytest.raises(ValueError, match="resolve"):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_rejects_a_required_cite_in_an_unknown_document() -> None:
    raw = _answer_item()
    raw["required_cites"] = [
        {"documentId": "CONDO_ACT", "segments": [{"kind": "section", "label": "117"}]}
    ]
    with pytest.raises(ValueError, match="resolve"):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_rejects_a_required_cite_that_overshoots_a_leaf() -> None:
    raw = _answer_item()
    raw["required_cites"] = [
        {
            "documentId": "RTA",
            "segments": [
                {"kind": "section", "label": "37"},
                {"kind": "subsection", "label": "1"},
            ],
        }
    ]
    with pytest.raises(ValueError, match="resolve"):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_accepts_a_descendant_required_cite_that_resolves() -> None:
    raw = _answer_item()
    raw["required_cites"] = [
        {
            "documentId": "RTA",
            "segments": [
                {"kind": "section", "label": "49"},
                {"kind": "subsection", "label": "1"},
                {"kind": "clause", "label": "a"},
            ],
        }
    ]
    item = parse_golden_item(raw, documents=_DOCUMENTS)
    assert len(item.required_cites) == 1


# --- AC 2: provenance, behavior class, answer points, paraphrase ----------


def test_rejects_missing_provenance() -> None:
    raw = _answer_item()
    del raw["provenance"]
    with pytest.raises(ValueError, match="provenance"):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_rejects_provenance_missing_source() -> None:
    raw = _answer_item()
    raw["provenance"] = {"reference": "no source key"}
    with pytest.raises(ValueError, match="source"):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_rejects_provenance_with_blank_reference() -> None:
    raw = _answer_item()
    raw["provenance"] = {"source": "ltb-interpretation-guideline", "reference": ""}
    with pytest.raises(ValueError):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_rejects_an_unknown_behavior_class() -> None:
    raw = _answer_item()
    raw["behavior_class"] = "answer-but-make-it-up"
    with pytest.raises(ValueError, match="behavior class"):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_rejects_malformed_answer_points_not_a_list() -> None:
    raw = _answer_item()
    raw["answer_points"] = {"id": "p1", "text": "single, not a list"}
    with pytest.raises(ValueError):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_rejects_an_empty_answer_points_list() -> None:
    raw = _answer_item()
    raw["answer_points"] = []
    with pytest.raises(ValueError, match="answer point"):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_rejects_an_answer_point_missing_text() -> None:
    raw = _answer_item()
    raw["answer_points"] = [{"id": "p1"}]
    with pytest.raises(ValueError):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_rejects_an_answer_point_with_blank_id() -> None:
    raw = _answer_item()
    raw["answer_points"] = [{"id": "", "text": "blank id"}]
    with pytest.raises(ValueError):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_rejects_duplicate_answer_point_ids_within_an_item() -> None:
    raw = _answer_item()
    raw["answer_points"] = [
        {"id": "dup", "text": "first"},
        {"id": "dup", "text": "second"},
    ]
    with pytest.raises(ValueError, match="duplicate"):
        parse_golden_item(raw, documents=_DOCUMENTS)


# --- strictness: reject, never coerce -------------------------------------


def test_rejects_unknown_top_level_key() -> None:
    raw = _answer_item()
    raw["surprise"] = "unexpected"
    with pytest.raises(ValueError, match="unknown"):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_rejects_missing_id() -> None:
    raw = _answer_item()
    del raw["id"]
    with pytest.raises(ValueError):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_rejects_missing_question() -> None:
    raw = _answer_item()
    del raw["question"]
    with pytest.raises(ValueError):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_rejects_non_boolean_verified() -> None:
    raw = _answer_item()
    raw["verified"] = "false"
    with pytest.raises(ValueError, match="verified"):
        parse_golden_item(raw, documents=_DOCUMENTS)


def test_rejects_a_non_mapping_item() -> None:
    with pytest.raises(ValueError):
        parse_golden_item(["not", "a", "mapping"], documents=_DOCUMENTS)  # type: ignore[arg-type]


def test_parsing_does_not_mutate_the_input_mapping() -> None:
    raw = _answer_item()
    snapshot = copy.deepcopy(raw)
    parse_golden_item(raw, documents=_DOCUMENTS)
    assert raw == snapshot
