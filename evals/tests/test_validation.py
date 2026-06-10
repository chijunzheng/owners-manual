"""Validation-guard tests: malformed input must raise, never silently coerce.

Covers the defensive branches of ``parse_citable_path`` and ``parse_document_tree``
that the conformance vectors (all well-formed) do not exercise.
"""

import pytest

from owners_manual_evals.citable_path import (
    CitablePath,
    CitablePathSegment,
    format_citable_path,
    parse_citable_path,
)
from owners_manual_evals.document_tree import parse_document_tree


def test_parse_citable_path_rejects_non_mapping() -> None:
    with pytest.raises(ValueError):
        parse_citable_path(["not", "a", "mapping"])  # type: ignore[arg-type]


def test_parse_citable_path_rejects_missing_document_id() -> None:
    with pytest.raises(ValueError):
        parse_citable_path({"segments": []})


def test_parse_citable_path_rejects_non_list_segments() -> None:
    with pytest.raises(ValueError):
        parse_citable_path({"documentId": "RTA", "segments": {}})


def test_parse_citable_path_rejects_segment_missing_kind() -> None:
    with pytest.raises(ValueError):
        parse_citable_path({"documentId": "RTA", "segments": [{"label": "1"}]})


def test_parse_citable_path_rejects_non_string_label() -> None:
    with pytest.raises(ValueError):
        parse_citable_path({"documentId": "RTA", "segments": [{"kind": "section", "label": 1}]})


def test_segment_rejects_unknown_kind() -> None:
    with pytest.raises(ValueError):
        CitablePathSegment(kind="paragraph", label="1")  # type: ignore[arg-type]


def test_segment_rejects_empty_label() -> None:
    with pytest.raises(ValueError):
        CitablePathSegment(kind="section", label="")


def test_citable_path_rejects_empty_document_id() -> None:
    with pytest.raises(ValueError):
        CitablePath(document_id="", segments=())


def test_parse_document_tree_rejects_non_mapping() -> None:
    with pytest.raises(ValueError):
        parse_document_tree("nope")  # type: ignore[arg-type]


def test_parse_document_tree_rejects_non_list_children() -> None:
    with pytest.raises(ValueError):
        parse_document_tree(
            {"kind": "document", "documentId": "RTA", "label": "RTA", "children": {}}
        )


def test_parse_document_tree_rejects_blank_document_id_on_child() -> None:
    with pytest.raises(ValueError):
        parse_document_tree(
            {
                "kind": "document",
                "documentId": "RTA",
                "label": "RTA",
                "children": [{"kind": "section", "label": "1", "documentId": "", "children": []}],
            }
        )


def test_format_renders_the_document_root_segment() -> None:
    path = CitablePath(
        document_id="RTA",
        segments=(CitablePathSegment(kind="document", label="RTA-ROOT"),),
    )
    assert format_citable_path(path) == "RTA / RTA-ROOT"
