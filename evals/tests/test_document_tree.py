"""Unit tests for the Python document-tree schema and citable-path addressing.

Mirrors the TypeScript ``document-tree.test.ts`` so the two implementations of
the shared domain stay behaviourally identical.
"""

import pytest

from owners_manual_evals.citable_path import (
    CitablePath,
    CitablePathSegment,
    format_citable_path,
    is_proper_ancestor,
    is_proper_descendant,
)
from owners_manual_evals.document_tree import (
    citable_path_of,
    parse_document_tree,
    walk_tree,
)

SAMPLE_TREE = {
    "kind": "document",
    "documentId": "RTA",
    "label": "RTA",
    "children": [
        {
            "kind": "part",
            "label": "V",
            "children": [
                {
                    "kind": "section",
                    "label": "49",
                    "children": [
                        {
                            "kind": "subsection",
                            "label": "1",
                            "children": [
                                {"kind": "clause", "label": "a", "children": []},
                                {"kind": "clause", "label": "b", "children": []},
                            ],
                        }
                    ],
                }
            ],
        }
    ],
}


def test_parses_a_hand_written_sample_tree() -> None:
    tree = parse_document_tree(SAMPLE_TREE)
    assert tree.document_id == "RTA"
    assert tree.kind == "document"


def test_rejects_a_non_document_root() -> None:
    bad = {**SAMPLE_TREE, "kind": "section"}
    with pytest.raises(ValueError):
        parse_document_tree(bad)


def test_rejects_an_empty_label() -> None:
    bad = {**SAMPLE_TREE, "children": [{"kind": "section", "label": "", "children": []}]}
    with pytest.raises(ValueError):
        parse_document_tree(bad)


def test_rejects_an_unknown_kind() -> None:
    bad = {**SAMPLE_TREE, "children": [{"kind": "paragraph", "label": "1", "children": []}]}
    with pytest.raises(ValueError):
        parse_document_tree(bad)


def test_every_node_carries_a_citable_path() -> None:
    tree = parse_document_tree(SAMPLE_TREE)
    rendered: list[str] = []

    def visit(_node, path: CitablePath) -> None:
        assert path.document_id == "RTA"
        rendered.append(format_citable_path(path))

    walk_tree(tree, visit)

    assert len(rendered) == 6
    assert "RTA" in rendered
    assert "RTA / Part V" in rendered
    assert "RTA / Part V / s. 49" in rendered
    assert "RTA / Part V / s. 49 / (1)" in rendered
    assert "RTA / Part V / s. 49 / (1) / (a)" in rendered
    assert "RTA / Part V / s. 49 / (1) / (b)" in rendered


def test_derives_the_citable_path_of_the_deepest_clause() -> None:
    tree = parse_document_tree(SAMPLE_TREE)
    clause_b = tree.children[0].children[0].children[0].children[1]

    path = citable_path_of(tree, clause_b)
    assert path is not None
    assert path.document_id == "RTA"
    assert [seg.label for seg in path.segments] == ["V", "49", "1", "b"]
    assert [seg.kind for seg in path.segments] == ["part", "section", "subsection", "clause"]


def _path(*segments: tuple[str, str], document_id: str = "RTA") -> CitablePath:
    return CitablePath(
        document_id=document_id,
        segments=tuple(CitablePathSegment(kind=kind, label=label) for kind, label in segments),
    )


def test_ancestor_and_descendant_relations() -> None:
    sec49 = _path(("section", "49"))
    sec49sub1 = _path(("section", "49"), ("subsection", "1"))
    sec49sub1cla = _path(("section", "49"), ("subsection", "1"), ("clause", "a"))
    sec50 = _path(("section", "50"))

    assert is_proper_ancestor(sec49, sec49sub1)
    assert is_proper_descendant(sec49sub1cla, sec49)
    assert not is_proper_ancestor(sec49, sec49)
    assert not is_proper_ancestor(sec49, sec50)
    assert not is_proper_descendant(sec50, sec49)

    other_doc = _path(("section", "49"), ("subsection", "1"), document_id="DECLARATION")
    assert not is_proper_ancestor(sec49, other_doc)
