"""Locate and load the committed golden v0 (issue #9, tenancy-only).

The runner loads ``evals/fixtures/golden/tenancy-v0.yaml`` against the committed
trees under ``trees/`` (reusing :func:`load_fixture_documents`). Golden v0 is
tenancy-scoped: its required cites resolve into the RTA, Reg 516/06, and the
designed lease/declaration trees the same ingest builds the index from, so the
harness and the service measure the same corpus.
"""

from __future__ import annotations

from .document_tree import DocumentTree
from .golden_fixtures import load_fixture_documents, resolve_fixtures_dir
from .golden_loader import GoldenSet, load_golden_items

#: Filename of the committed golden-v0 tenancy set.
_GOLDEN_V0_FILENAME = "tenancy-v0.yaml"


def load_golden_v0_documents() -> tuple[DocumentTree, ...]:
    """The committed trees golden-v0 cites resolve against (all ``*.tree.json``)."""
    return load_fixture_documents()


def load_golden_v0_set() -> GoldenSet:
    """Load and validate the committed golden-v0 set against the fixture trees."""
    documents = load_golden_v0_documents()
    path = resolve_fixtures_dir() / _GOLDEN_V0_FILENAME
    return load_golden_items(path, documents=documents)


__all__ = ["load_golden_v0_documents", "load_golden_v0_set"]
