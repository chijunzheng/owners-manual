"""The typed document tree (Python side).

Mirror of ``packages/core/src/document-tree.ts``. The canonical intermediate
representation of one parsed source — Part -> section -> subsection -> clause —
with a citable path derivable for every node. This is the shared domain the
Python grader builds its hierarchical cite scoring on.

Tree nodes compare by identity (``eq=False``), not by value, so two distinct
nodes that happen to share a kind/label are never confused when resolving the
citable path of a specific node.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from .citable_path import (
    SEGMENT_KINDS,
    CitablePath,
    CitablePathSegment,
    SegmentKind,
)


@dataclass(eq=False, slots=True)
class DocumentNode:
    """A node of the document tree: its kind, label, and children. ``document_id``
    is present only on the root."""

    kind: SegmentKind
    label: str
    children: tuple[DocumentNode, ...] = ()
    document_id: str | None = field(default=None)


@dataclass(eq=False, slots=True)
class DocumentTree(DocumentNode):
    """A whole parsed document: a tree rooted at a ``document`` node carrying its id."""


def parse_document_tree(value: dict) -> DocumentTree:
    """Validate and normalize an untyped mapping into a :class:`DocumentTree`.

    Raises :class:`ValueError` if the root is not a ``document`` node, if it
    carries no id, or if any node has an unknown kind or empty label.
    """
    node = _parse_node(value)
    if node.kind != "document":
        raise ValueError(f'document tree root must be a "document" node, got "{node.kind}"')
    if not node.document_id:
        raise ValueError("document tree root must carry a non-empty documentId")
    return DocumentTree(
        kind="document",
        label=node.label,
        children=node.children,
        document_id=node.document_id,
    )


def _parse_node(value: object) -> DocumentNode:
    if not isinstance(value, dict):
        raise ValueError(f"document node must be a mapping, got {type(value).__name__}")
    kind = value.get("kind")
    if kind not in SEGMENT_KINDS:
        raise ValueError(f"unknown document-node kind: {kind!r}")
    label = value.get("label")
    if not isinstance(label, str) or not label:
        raise ValueError("document node requires a non-empty string label")
    document_id = value.get("documentId")
    if document_id is not None and (not isinstance(document_id, str) or not document_id):
        raise ValueError("document node documentId, when present, must be a non-empty string")
    raw_children = value.get("children", [])
    if not isinstance(raw_children, list):
        raise ValueError("document node children must be a list")
    children = tuple(_parse_node(child) for child in raw_children)
    return DocumentNode(kind=kind, label=label, children=children, document_id=document_id)


def walk_tree(tree: DocumentTree, visit: Callable[[DocumentNode, CitablePath], None]) -> None:
    """Visit every node depth-first, root included, handing each node the citable
    path that addresses it. The root's path has an empty segment tuple; the root
    ``document`` segment is carried by ``path.document_id``, not duplicated."""
    document_id = tree.document_id or ""

    def recurse(node: DocumentNode, segments: tuple[CitablePathSegment, ...]) -> None:
        visit(node, CitablePath(document_id=document_id, segments=segments))
        for child in node.children:
            recurse(node=child, segments=(*segments, CitablePathSegment(child.kind, child.label)))

    recurse(node=tree, segments=())


def citable_path_of(tree: DocumentTree, target: DocumentNode) -> CitablePath | None:
    """Resolve the citable path of ``target`` by identity within ``tree``, or
    ``None`` if ``target`` is not a node of the tree."""
    document_id = tree.document_id or ""
    found: CitablePath | None = None

    def recurse(node: DocumentNode, segments: tuple[CitablePathSegment, ...]) -> None:
        nonlocal found
        if found is not None:
            return
        if node is target:
            found = CitablePath(document_id=document_id, segments=segments)
            return
        for child in node.children:
            recurse(node=child, segments=(*segments, CitablePathSegment(child.kind, child.label)))

    recurse(node=tree, segments=())
    return found


__all__ = [
    "DocumentNode",
    "DocumentTree",
    "parse_document_tree",
    "walk_tree",
    "citable_path_of",
]
