"""Citable-path addressing for the document tree (Python side).

Mirror of ``packages/core/src/citable-path.ts``. A pin-cite (CONTEXT.md)
resolves to a citable unit — the smallest document-tree node a citation can
address. A :class:`CitablePath` is that address: a ``document_id`` plus an
ordered tuple of typed segments from the document root down to the cited node
(Part -> section -> subsection -> clause). Structured segments (not a display
string) make the hierarchical relation a clean prefix check and keep the
shared conformance vectors free of any parsing dialect.

The dataclasses are frozen: addresses are values, never mutated in place.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, get_args

#: The node kinds a document tree distinguishes, root-first.
SegmentKind = Literal["document", "part", "section", "subsection", "clause"]

SEGMENT_KINDS: tuple[SegmentKind, ...] = get_args(SegmentKind)


@dataclass(frozen=True, slots=True)
class CitablePathSegment:
    """One step in a citable path: the node's kind and label (e.g. section "49")."""

    kind: SegmentKind
    label: str

    def __post_init__(self) -> None:
        if self.kind not in SEGMENT_KINDS:
            raise ValueError(f"unknown segment kind: {self.kind!r}")
        if not self.label:
            raise ValueError("citable-path segment label must be non-empty")


@dataclass(frozen=True, slots=True)
class CitablePath:
    """The address of one document-tree node: which document, and the ordered
    segments from its root to the node. An empty ``segments`` tuple addresses
    the document root itself."""

    document_id: str
    segments: tuple[CitablePathSegment, ...]

    def __post_init__(self) -> None:
        if not self.document_id:
            raise ValueError("citable path must carry a non-empty document_id")


def parse_citable_path(value: dict) -> CitablePath:
    """Validate and normalize an untyped mapping into a :class:`CitablePath`."""
    if not isinstance(value, dict):
        raise ValueError(f"citable path must be a mapping, got {type(value).__name__}")
    document_id = value.get("documentId")
    if not isinstance(document_id, str) or not document_id:
        raise ValueError("citable path requires a non-empty string documentId")
    raw_segments = value.get("segments", [])
    if not isinstance(raw_segments, list):
        raise ValueError("citable path segments must be a list")
    segments = tuple(
        CitablePathSegment(kind=_require_str(seg, "kind"), label=_require_str(seg, "label"))
        for seg in raw_segments
    )
    return CitablePath(document_id=document_id, segments=segments)


def _require_str(mapping: object, key: str) -> str:
    if not isinstance(mapping, dict) or key not in mapping:
        raise ValueError(f"segment is missing required key {key!r}")
    value = mapping[key]
    if not isinstance(value, str):
        raise ValueError(f"segment {key!r} must be a string")
    return value


def citable_paths_equal(a: CitablePath, b: CitablePath) -> bool:
    """True when two citable paths address the same node of the same document."""
    return a.document_id == b.document_id and a.segments == b.segments


def is_proper_ancestor(maybe_ancestor: CitablePath, maybe_path: CitablePath) -> bool:
    """True when ``maybe_ancestor`` is a strict prefix of ``maybe_path`` within
    the same document. Kinds must agree segment-for-segment, so a mislabeled
    coordinate (a clause "1" vs a subsection "1") is not the same node."""
    if maybe_ancestor.document_id != maybe_path.document_id:
        return False
    if len(maybe_ancestor.segments) >= len(maybe_path.segments):
        return False
    return maybe_ancestor.segments == maybe_path.segments[: len(maybe_ancestor.segments)]


def is_proper_descendant(maybe_descendant: CitablePath, maybe_path: CitablePath) -> bool:
    """True when ``maybe_descendant`` sits strictly lower on the same line."""
    return is_proper_ancestor(maybe_path, maybe_descendant)


def format_citable_path(path: CitablePath) -> str:
    """Render a citable path for human review (e.g. "RTA / Part V / s. 49 / (1)")."""
    parts = [path.document_id]
    for segment in path.segments:
        if segment.kind == "part":
            parts.append(f"Part {segment.label}")
        elif segment.kind == "section":
            parts.append(f"s. {segment.label}")
        elif segment.kind in ("subsection", "clause"):
            parts.append(f"({segment.label})")
        else:  # document
            parts.append(segment.label)
    return " / ".join(parts)


__all__ = [
    "SEGMENT_KINDS",
    "SegmentKind",
    "CitablePath",
    "CitablePathSegment",
    "parse_citable_path",
    "citable_paths_equal",
    "is_proper_ancestor",
    "is_proper_descendant",
    "format_citable_path",
]
