"""Tests over the committed golden fixtures.

The fixtures (``evals/fixtures/golden``) are committed JSON document trees in the
conformance-vector tree shape — addressing only, no Crown-copyright text — plus
a sample-items YAML that exercises every schema feature. These tests prove the
committed fixtures load against the committed trees, cover all five behavior
classes, are every-one unverified, and are therefore excluded by default from an
eval run (issue #30 AC 3 and 5).
"""

from __future__ import annotations

from owners_manual_evals.golden_fixtures import (
    load_fixture_documents,
    load_sample_golden_set,
)
from owners_manual_evals.golden_item import BEHAVIOR_CLASSES
from owners_manual_evals.golden_loader import assign_split, eval_run_items


def test_fixture_trees_parse() -> None:
    documents = load_fixture_documents()
    ids = {tree.document_id for tree in documents}
    assert {"RTA", "DECLARATION"} <= ids


def test_sample_items_load_against_the_fixture_trees() -> None:
    # The whole point: every sample item's required cites resolve against the
    # committed trees, so loading succeeds without raising.
    golden_set = load_sample_golden_set()
    assert len(golden_set.items) >= 5


def test_sample_items_cover_every_behavior_class() -> None:
    golden_set = load_sample_golden_set()
    covered = {item.behavior_class for item in golden_set.items}
    assert covered == set(BEHAVIOR_CLASSES)


def test_every_sample_item_is_unverified() -> None:
    golden_set = load_sample_golden_set()
    assert all(item.verified is False for item in golden_set.items)


def test_sample_items_are_excluded_from_an_eval_run_by_default() -> None:
    golden_set = load_sample_golden_set()
    assert eval_run_items(golden_set) == ()


def test_sample_set_contains_a_paraphrase_group() -> None:
    golden_set = load_sample_golden_set()
    assert any(item.paraphrase_of is not None for item in golden_set.items)


def test_sample_set_splits_deterministically() -> None:
    golden_set = load_sample_golden_set()
    split = assign_split(golden_set.items)
    assert set(split) == {item.id for item in golden_set.items}
    # A paraphrase variant lands on the same side as its parent.
    for item in golden_set.items:
        if item.paraphrase_of is not None:
            assert split[item.id] == split[item.paraphrase_of]
