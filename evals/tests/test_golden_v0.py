"""Golden-v0 loader tests (issue #10).

The runner loads the committed golden v0 (``tenancy-v0.yaml``) against the
committed trees. These pin that the set loads, validates, and yields a non-empty
verified eval run — the same bytes the live command runs.
"""

from __future__ import annotations

from owners_manual_evals.golden_loader import eval_run_items
from owners_manual_evals.golden_v0 import load_golden_v0_documents, load_golden_v0_set


def test_loads_the_golden_v0_documents() -> None:
    documents = load_golden_v0_documents()
    ids = {doc.document_id for doc in documents}
    # Tenancy-only golden v0 cites resolve into these committed trees.
    assert "rta-2006" in ids
    assert "fixture-lease" in ids


def test_loads_and_validates_the_golden_v0_set() -> None:
    golden = load_golden_v0_set()
    assert golden.version == 1
    assert len(golden.items) > 0


def test_golden_v0_yields_a_non_empty_verified_run() -> None:
    golden = load_golden_v0_set()
    runnable = eval_run_items(golden)
    assert len(runnable) > 0
    assert all(item.verified for item in runnable)
