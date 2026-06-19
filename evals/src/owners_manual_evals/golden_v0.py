"""Locate and load the committed golden v0 (issue #9, tenancy-only).

The runner loads the committed per-corpus golden items from
``evals/fixtures/golden/items/`` against the committed trees under ``trees/``
(reusing :func:`load_fixture_documents`): every ``*.yaml`` there is concatenated
into one validated set. Required cites resolve into the RTA, Reg 516/06, the
Condo Act, and the designed fixture trees the same ingest builds the index from,
so the harness and the service measure the same corpus. ("v0" is the historical
module name from #9–#10; the set is now the multi-corpus golden v1, #22.)
"""

from __future__ import annotations

from .document_tree import DocumentTree
from .golden_fixtures import load_fixture_documents, resolve_fixtures_dir
from .golden_loader import GoldenSet, load_golden_items

#: Subdirectory holding the committed per-corpus golden item files (#22); the
#: loader concatenates every ``*.yaml`` there into one validated set.
_GOLDEN_ITEMS_DIRNAME = "items"


def load_golden_v0_documents() -> tuple[DocumentTree, ...]:
    """The committed trees golden-v0 cites resolve against (all ``*.tree.json``)."""
    return load_fixture_documents()


def load_golden_v0_set() -> GoldenSet:
    """Load and validate the committed golden set against the fixture trees.

    Loads the per-corpus ``items/`` directory: every ``*.yaml`` there is parsed
    and concatenated into one validated set, so a paraphrase variant may live in
    a different file from its parent."""
    documents = load_golden_v0_documents()
    items_dir = resolve_fixtures_dir() / _GOLDEN_ITEMS_DIRNAME
    return load_golden_items(items_dir, documents=documents)


__all__ = ["load_golden_v0_documents", "load_golden_v0_set"]
