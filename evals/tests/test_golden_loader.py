"""Loader, split, and verified-only-filtering tests for the golden set.

Pins issue #30 acceptance criteria 2 (paraphrase parent must exist), 4
(deterministic, stratified, ~70/30 split; paraphrase variants inherit their
parent's side), and 5 (unverified items load for schema tests but are excluded
by default from an eval run).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

from owners_manual_evals.document_tree import parse_document_tree
from owners_manual_evals.golden_loader import (
    GoldenSet,
    assign_split,
    eval_run_items,
    load_golden_items,
    load_golden_items_from_text,
)

_RTA_TREE = {
    "kind": "document",
    "documentId": "RTA",
    "label": "RTA",
    "children": [
        {"kind": "section", "label": "49", "children": []},
        {"kind": "section", "label": "37", "children": []},
    ],
}

_DOCUMENTS = (parse_document_tree(_RTA_TREE),)


def _item_yaml(
    *,
    item_id: str,
    behavior_class: str = "answer",
    verified: bool = True,
    paraphrase_of: str | None = None,
) -> str:
    cite = (
        "    required_cites:\n"
        "      - documentId: RTA\n"
        "        segments:\n"
        '          - { kind: section, label: "49" }\n'
        if behavior_class in ("answer", "flag-void-clause")
        else "    required_cites: []\n"
    )
    parent = f"    paraphrase_of: {paraphrase_of}\n" if paraphrase_of else ""
    return (
        f"  - id: {item_id}\n"
        f"    behavior_class: {behavior_class}\n"
        f"    verified: {str(verified).lower()}\n"
        f"{parent}"
        f"    question: Q for {item_id}?\n"
        f"    answer_points:\n"
        f"      - id: p1\n"
        f"        text: A point.\n"
        f"{cite}"
        f"    provenance:\n"
        f"      source: designed-fixture\n"
        f"      reference: fixture {item_id}\n"
    )


def _set_yaml(item_bodies: list[str]) -> str:
    return "version: 1\nitems:\n" + "".join(item_bodies)


# --- loading ---------------------------------------------------------------


def test_loads_a_minimal_set_from_text() -> None:
    text = _set_yaml([_item_yaml(item_id="a"), _item_yaml(item_id="b")])
    result = load_golden_items_from_text(text, documents=_DOCUMENTS)
    assert isinstance(result, GoldenSet)
    assert {item.id for item in result.items} == {"a", "b"}


def test_loads_a_set_from_a_yaml_file(tmp_path) -> None:
    path = tmp_path / "items.yaml"
    path.write_text(_set_yaml([_item_yaml(item_id="a"), _item_yaml(item_id="b")]), encoding="utf-8")
    result = load_golden_items(path, documents=_DOCUMENTS)
    assert {item.id for item in result.items} == {"a", "b"}


def test_loads_and_concatenates_every_yaml_file_in_a_directory(tmp_path) -> None:
    (tmp_path / "first.yaml").write_text(_set_yaml([_item_yaml(item_id="a")]), encoding="utf-8")
    (tmp_path / "second.yml").write_text(_set_yaml([_item_yaml(item_id="b")]), encoding="utf-8")
    # A non-YAML sibling is ignored.
    (tmp_path / "notes.txt").write_text("ignored", encoding="utf-8")
    result = load_golden_items(tmp_path, documents=_DOCUMENTS)
    assert {item.id for item in result.items} == {"a", "b"}


def test_rejects_a_duplicate_id_across_directory_files(tmp_path) -> None:
    (tmp_path / "first.yaml").write_text(_set_yaml([_item_yaml(item_id="dup")]), encoding="utf-8")
    (tmp_path / "second.yaml").write_text(_set_yaml([_item_yaml(item_id="dup")]), encoding="utf-8")
    with pytest.raises(ValueError, match="duplicate"):
        load_golden_items(tmp_path, documents=_DOCUMENTS)


def test_rejects_a_duplicate_item_id_across_the_set() -> None:
    text = _set_yaml([_item_yaml(item_id="dup"), _item_yaml(item_id="dup")])
    with pytest.raises(ValueError, match="duplicate"):
        load_golden_items_from_text(text, documents=_DOCUMENTS)


def test_rejects_a_set_with_no_items() -> None:
    with pytest.raises(ValueError, match="item"):
        load_golden_items_from_text("version: 1\nitems: []\n", documents=_DOCUMENTS)


def test_rejects_a_missing_version() -> None:
    text = "items:\n" + _item_yaml(item_id="a")
    with pytest.raises(ValueError, match="version"):
        load_golden_items_from_text(text, documents=_DOCUMENTS)


def test_rejects_unknown_top_level_set_key() -> None:
    text = "version: 1\nsurprise: 1\nitems:\n" + _item_yaml(item_id="a")
    with pytest.raises(ValueError, match="unknown"):
        load_golden_items_from_text(text, documents=_DOCUMENTS)


# --- AC 2: a paraphrase variant whose parent is absent is rejected ---------


def test_rejects_a_paraphrase_variant_whose_parent_is_absent() -> None:
    text = _set_yaml([_item_yaml(item_id="child", paraphrase_of="ghost-parent")])
    with pytest.raises(ValueError, match="parent"):
        load_golden_items_from_text(text, documents=_DOCUMENTS)


def test_accepts_a_paraphrase_variant_whose_parent_is_present() -> None:
    text = _set_yaml(
        [
            _item_yaml(item_id="parent"),
            _item_yaml(item_id="child", paraphrase_of="parent"),
        ]
    )
    result = load_golden_items_from_text(text, documents=_DOCUMENTS)
    assert {item.id for item in result.items} == {"parent", "child"}


def test_rejects_a_paraphrase_chain_whose_parent_is_itself_a_paraphrase() -> None:
    # Paraphrase variants must hang off a real parent item, not off another
    # paraphrase: a child can only inherit a side from a true parent.
    text = _set_yaml(
        [
            _item_yaml(item_id="parent"),
            _item_yaml(item_id="child", paraphrase_of="parent"),
            _item_yaml(item_id="grandchild", paraphrase_of="child"),
        ]
    )
    with pytest.raises(ValueError, match="paraphrase"):
        load_golden_items_from_text(text, documents=_DOCUMENTS)


# --- AC 4: deterministic, stratified ~70/30 split --------------------------


def _balanced_parent_set() -> GoldenSet:
    bodies: list[str] = []
    classes = [
        "answer",
        "refuse-jurisdiction",
        "refuse-out-of-scope",
        "refuse-advice-escalate",
        "flag-void-clause",
    ]
    for behavior_class in classes:
        for i in range(10):
            bodies.append(
                _item_yaml(item_id=f"{behavior_class}-{i}", behavior_class=behavior_class)
            )
    return load_golden_items_from_text(_set_yaml(bodies), documents=_DOCUMENTS)


def test_split_is_deterministic_across_calls() -> None:
    items = _balanced_parent_set().items
    first = assign_split(items)
    second = assign_split(items)
    assert {k: v for k, v in first.items()} == {k: v for k, v in second.items()}


def test_split_is_independent_of_input_ordering() -> None:
    items = list(_balanced_parent_set().items)
    forward = assign_split(tuple(items))
    backward = assign_split(tuple(reversed(items)))
    assert forward == backward


def test_split_is_stratified_seventy_thirty_per_behavior_class() -> None:
    items = _balanced_parent_set().items
    split = assign_split(items)
    by_class: dict[str, list[str]] = {}
    for item in items:
        by_class.setdefault(item.behavior_class, []).append(split[item.id])
    for behavior_class, sides in by_class.items():
        dev = sides.count("dev")
        holdout = sides.count("holdout")
        assert dev + holdout == 10
        # 10 items at ~70/30 -> 7 dev, 3 holdout in each stratum.
        assert dev == 7, f"{behavior_class}: expected 7 dev, got {dev}"
        assert holdout == 3, f"{behavior_class}: expected 3 holdout, got {holdout}"


def test_only_two_sides_are_assigned() -> None:
    split = assign_split(_balanced_parent_set().items)
    assert set(split.values()) == {"dev", "holdout"}


def test_every_item_receives_exactly_one_side() -> None:
    items = _balanced_parent_set().items
    split = assign_split(items)
    assert set(split) == {item.id for item in items}


def test_split_is_reproducible_across_python_hash_seeds() -> None:
    # "Deterministic" must survive a fresh interpreter with a different
    # PYTHONHASHSEED: the ordering key is a SHA-256 digest, not the salted
    # builtin hash(), so two processes must agree on the exact partition.
    items = _balanced_parent_set().items
    in_process = assign_split(items)

    rebuilt = _set_yaml([_item_yaml(item_id=i.id, behavior_class=i.behavior_class) for i in items])
    snippet = (
        "import json\n"
        "from owners_manual_evals.document_tree import parse_document_tree\n"
        "from owners_manual_evals.golden_loader import "
        "assign_split, load_golden_items_from_text\n"
        f"tree = parse_document_tree({_RTA_TREE!r})\n"
        f"result = load_golden_items_from_text({rebuilt!r}, documents=(tree,))\n"
        "print(json.dumps(assign_split(result.items), sort_keys=True))\n"
    )
    env = {**os.environ, "PYTHONHASHSEED": "1"}
    completed = subprocess.run(
        [sys.executable, "-c", snippet],
        capture_output=True,
        text=True,
        env=env,
        check=True,
    )
    other_process = json.loads(completed.stdout)
    assert other_process == in_process


# --- AC 4: paraphrase variants inherit their parent's side -----------------


def test_paraphrase_variants_inherit_their_parents_side() -> None:
    bodies: list[str] = []
    # Many parents so both sides are populated, each with a paraphrase child.
    for i in range(10):
        bodies.append(_item_yaml(item_id=f"parent-{i}"))
        bodies.append(_item_yaml(item_id=f"child-{i}", paraphrase_of=f"parent-{i}"))
    result = load_golden_items_from_text(_set_yaml(bodies), documents=_DOCUMENTS)
    split = assign_split(result.items)
    for i in range(10):
        assert split[f"child-{i}"] == split[f"parent-{i}"]


def test_paraphrase_children_do_not_change_their_parents_stratum_counts() -> None:
    # Adding paraphrase children must not perturb the 70/30 over parents: the
    # split is computed on parents, children inherit.
    parents_only: list[str] = [_item_yaml(item_id=f"answer-{i}") for i in range(10)]
    with_children = list(parents_only)
    for i in range(10):
        with_children.append(_item_yaml(item_id=f"child-{i}", paraphrase_of=f"answer-{i}"))

    base = load_golden_items_from_text(_set_yaml(parents_only), documents=_DOCUMENTS)
    augmented = load_golden_items_from_text(_set_yaml(with_children), documents=_DOCUMENTS)

    base_split = assign_split(base.items)
    augmented_split = assign_split(augmented.items)
    for i in range(10):
        assert base_split[f"answer-{i}"] == augmented_split[f"answer-{i}"]


# --- AC 5: verified-only filtering for an eval run -------------------------


def test_unverified_items_load_but_are_excluded_from_an_eval_run() -> None:
    text = _set_yaml(
        [
            _item_yaml(item_id="verified-one", verified=True),
            _item_yaml(item_id="unverified-one", verified=False),
        ]
    )
    result = load_golden_items_from_text(text, documents=_DOCUMENTS)
    # All items load (schema tests can see both).
    assert {item.id for item in result.items} == {"verified-one", "unverified-one"}
    # The eval run sees only verified items, by default.
    run = eval_run_items(result)
    assert {item.id for item in run} == {"verified-one"}


def test_eval_run_is_empty_when_every_item_is_unverified() -> None:
    text = _set_yaml(
        [
            _item_yaml(item_id="u1", verified=False),
            _item_yaml(item_id="u2", verified=False),
        ]
    )
    result = load_golden_items_from_text(text, documents=_DOCUMENTS)
    assert eval_run_items(result) == ()


def test_eval_run_drops_a_verified_paraphrase_whose_parent_is_unverified() -> None:
    # A verified paraphrase cannot enter an eval run if its parent is excluded:
    # the robustness delta is parent-vs-paraphrase, so an orphaned variant is
    # not runnable. Both load for schema tests; neither enters the run.
    text = _set_yaml(
        [
            _item_yaml(item_id="parent", verified=False),
            _item_yaml(item_id="child", verified=True, paraphrase_of="parent"),
        ]
    )
    result = load_golden_items_from_text(text, documents=_DOCUMENTS)
    assert {item.id for item in result.items} == {"parent", "child"}
    assert eval_run_items(result) == ()
