"""The live-indexed corpus mirror stays in lockstep with the TS ingest registry.

Source of truth: ``packages/pipeline/src/corpus-loader.ts`` (``GOLDEN_V0_DOCUMENTS``).
Python cannot import the TS module, so this reads the file and derives the indexed
doc ids — a real cross-language drift guard, the same contract
``test_fixture_design.py`` keeps. If the live corpus expands on the TS side
without updating the Python mirror, this fails, so live runs can never silently
admit or exclude the wrong items.
"""

from __future__ import annotations

import re
from pathlib import Path

from owners_manual_evals.citable_path import parse_citable_path
from owners_manual_evals.golden_item import AnswerPoint, GoldenItem, Provenance
from owners_manual_evals.live_corpus import LIVE_INDEXED_DOCUMENT_IDS, is_live_serviceable


def _ts_golden_v0_document_ids() -> frozenset[str]:
    for ancestor in Path(__file__).resolve().parents:
        candidate = ancestor / "packages" / "pipeline" / "src" / "corpus-loader.ts"
        if candidate.is_file():
            text = candidate.read_text(encoding="utf-8")
            break
    else:
        raise AssertionError(
            "could not locate packages/pipeline/src/corpus-loader.ts above "
            f"{Path(__file__).resolve()}; the live-corpus source of truth must be present"
        )
    block = re.search(r"GOLDEN_V0_DOCUMENTS[^=]*=\s*\[(.*?)\n\]", text, re.DOTALL)
    assert block is not None, "GOLDEN_V0_DOCUMENTS array not found in corpus-loader.ts"
    return frozenset(re.findall(r"id:\s*'([^']+)'", block.group(1)))


def test_mirror_matches_the_ts_ingest_registry() -> None:
    assert LIVE_INDEXED_DOCUMENT_IDS == _ts_golden_v0_document_ids()


def _item(*doc_ids: str) -> GoldenItem:
    return GoldenItem(
        id="x",
        behavior_class="answer",
        verified=True,
        question="q",
        answer_points=(AnswerPoint(id="p", text="t"),),
        required_cites=tuple(
            parse_citable_path({"documentId": d, "segments": [{"kind": "section", "label": "1"}]})
            for d in doc_ids
        ),
        provenance=Provenance(source="s", reference="r"),
        corpus="tenancy",
    )


def test_item_with_all_cites_live_indexed_is_serviceable() -> None:
    assert is_live_serviceable(_item("rta-2006", "fixture-declaration"))


def test_item_with_a_non_indexed_cite_is_not_serviceable() -> None:
    # The insurance policy fixtures are tree-resolvable offline but not live-indexed.
    assert not is_live_serviceable(_item("rta-2006", "fixture-master-policy"))


def test_a_citeless_item_is_serviceable() -> None:
    # A refusal item has nothing to retrieve, so the live service can always serve it.
    assert is_live_serviceable(_item())
