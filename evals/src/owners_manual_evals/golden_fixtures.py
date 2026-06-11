"""Locate and load the committed golden fixtures (Python side).

The fixtures live at ``evals/fixtures/golden``:

* ``trees/*.tree.json`` — document trees in the conformance-vector tree shape
  (``{kind, documentId, label, children}``), addressing only. No Crown-copyright
  statute text — labels are bare coordinates, never section prose.
* ``sample-items.yaml`` — golden items, all ``verified: false``, that exercise
  every schema feature against those trees. The real, hand-verified items live
  in issue #9; these are excluded from any eval run by default.

This module resolves that directory by walking up from here to the evals root
(or via the ``OWNERS_MANUAL_GOLDEN_FIXTURES`` override) so tests and future
harness code load the same committed bytes without hard-coding an absolute path.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .document_tree import DocumentTree, parse_document_tree
from .golden_loader import GoldenSet, load_golden_items

#: Path of the golden fixtures directory relative to the evals package root.
_FIXTURES_RELPATH = Path("fixtures") / "golden"

#: Environment variable that overrides the resolved fixtures directory.
FIXTURES_PATH_ENV = "OWNERS_MANUAL_GOLDEN_FIXTURES"

#: Filename of the committed unverified sample items.
_SAMPLE_ITEMS_FILENAME = "sample-items.yaml"


def resolve_fixtures_dir() -> Path:
    """Locate the committed golden-fixtures directory: the env override if set,
    else the first ancestor of this file that contains ``fixtures/golden``."""
    override = os.environ.get(FIXTURES_PATH_ENV)
    if override:
        return Path(override)
    for ancestor in Path(__file__).resolve().parents:
        candidate = ancestor / _FIXTURES_RELPATH
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError(
        f"could not locate {_FIXTURES_RELPATH} above {Path(__file__).resolve()}; "
        f"set {FIXTURES_PATH_ENV} to point at the committed fixtures directory"
    )


def load_fixture_documents() -> tuple[DocumentTree, ...]:
    """Parse every ``*.tree.json`` fixture tree, in sorted filename order."""
    trees_dir = resolve_fixtures_dir() / "trees"
    files = sorted(trees_dir.glob("*.tree.json"))
    if not files:
        raise FileNotFoundError(f"no *.tree.json fixtures found in {trees_dir}")
    return tuple(
        parse_document_tree(json.loads(path.read_text(encoding="utf-8"))) for path in files
    )


def load_sample_golden_set() -> GoldenSet:
    """Load the committed sample items, validated against the fixture trees."""
    documents = load_fixture_documents()
    sample_path = resolve_fixtures_dir() / _SAMPLE_ITEMS_FILENAME
    return load_golden_items(sample_path, documents=documents)


__all__ = [
    "FIXTURES_PATH_ENV",
    "resolve_fixtures_dir",
    "load_fixture_documents",
    "load_sample_golden_set",
]
