"""Loader for the cross-language cite-matcher conformance vectors (Python side).

There is ONE committed vector file —
``packages/core/conformance/cite-matcher-vectors.json`` — and two suites that
must agree on it: the TypeScript core library and this Python grader. This
module locates that exact file (walking up from here to the repo root, or via
the ``OWNERS_MANUAL_CONFORMANCE_VECTORS`` override) and validates its shape, so
a malformed or drifted vector set fails loudly rather than skewing a verdict.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

from .citable_path import CitablePath, parse_citable_path
from .cite_matcher import CITE_VERDICTS, CiteVerdict
from .document_tree import DocumentTree, parse_document_tree

#: Repo-root-relative location of the single committed vector file.
_VECTORS_RELPATH = Path("packages") / "core" / "conformance" / "cite-matcher-vectors.json"

#: Environment variable that overrides the resolved vector-file path.
VECTORS_PATH_ENV = "OWNERS_MANUAL_CONFORMANCE_VECTORS"


@dataclass(frozen=True, slots=True)
class ConformanceCase:
    """One conformance vector: a required and candidate cite and the verdict
    the matcher must return for them."""

    id: str
    required: CitablePath
    candidate: CitablePath
    expected: CiteVerdict
    describe: str = ""


@dataclass(frozen=True, slots=True)
class ConformanceVectors:
    version: int
    documents: tuple[DocumentTree, ...]
    cases: tuple[ConformanceCase, ...]


def resolve_vectors_path() -> Path:
    """Locate the committed vector file: the env override if set, else the first
    repo root at or above this file that contains the known relative path."""
    override = os.environ.get(VECTORS_PATH_ENV)
    if override:
        return Path(override)
    for ancestor in Path(__file__).resolve().parents:
        candidate = ancestor / _VECTORS_RELPATH
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        f"could not locate {_VECTORS_RELPATH} above {Path(__file__).resolve()}; "
        f"set {VECTORS_PATH_ENV} to point at the committed vector file"
    )


def load_conformance_vectors(path: Path | str | None = None) -> ConformanceVectors:
    """Read, parse, and validate the committed conformance vectors."""
    resolved = Path(path) if path is not None else resolve_vectors_path()
    raw = json.loads(resolved.read_text(encoding="utf-8"))

    version = raw.get("version")
    if not isinstance(version, int) or version < 1:
        raise ValueError("conformance vectors require an integer version >= 1")

    documents = tuple(parse_document_tree(entry["tree"]) for entry in raw.get("documents", []))
    cases = tuple(_parse_case(entry) for entry in raw.get("cases", []))
    if not cases:
        raise ValueError("conformance vectors must contain at least one case")

    return ConformanceVectors(version=version, documents=documents, cases=cases)


def _parse_case(entry: dict) -> ConformanceCase:
    expected = entry["expected"]
    if expected not in CITE_VERDICTS:
        raise ValueError(f"unknown expected verdict {expected!r} in case {entry.get('id')!r}")
    return ConformanceCase(
        id=entry["id"],
        required=parse_citable_path(entry["required"]),
        candidate=parse_citable_path(entry["candidate"]),
        expected=expected,
        describe=entry.get("describe", ""),
    )


__all__ = [
    "ConformanceCase",
    "ConformanceVectors",
    "VECTORS_PATH_ENV",
    "resolve_vectors_path",
    "load_conformance_vectors",
]
