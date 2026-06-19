"""The live indexed corpus (Python mirror of the TS ingest registry).

Mirrors ``GOLDEN_V0_DOCUMENTS`` in ``packages/pipeline/src/corpus-loader.ts`` —
the documents the deployed service actually chunks, embeds, and can retrieve.

The offline document trees (``evals/fixtures/golden/trees/``) are corpus-COMPLETE
for cite resolution, but the live index is the tenancy-v0 subset; the two
deliberately diverge (offline ⊇ live). A golden item is "live-serviceable" only
if every required cite addresses a live-indexed document. Items that are not yet
live-serviceable — e.g. the insurance slice before the corpus expansion and
re-ingest — are offline-validated and verified, but must NOT enter LIVE runs (the
per-merge smoke gate, or the four-arm service eval), or they would report false
failures the service cannot satisfy. When the live corpus grows, this set and
``GOLDEN_V0_DOCUMENTS`` grow in lockstep (a test reads the TS source to guard it).
"""

from __future__ import annotations

from .golden_item import GoldenItem

#: Document ids the live service indexes, mirroring ``GOLDEN_V0_DOCUMENTS``
#: (corpus-loader.ts) by hand — the same lockstep contract ``oracle.py`` and
#: ``fixture_design.py`` keep with the TS registries. Extend here and in
#: corpus-loader.ts together (then re-ingest) when the live corpus expands.
LIVE_INDEXED_DOCUMENT_IDS: frozenset[str] = frozenset(
    {
        "rta-2006",
        "reg-516-06",
        "fixture-lease",
        "fixture-declaration",
    }
)


def is_live_serviceable(item: GoldenItem) -> bool:
    """Whether the live service can retrieve every cite this item requires.

    True for an item with no required cites (a refusal item — nothing to
    retrieve). False as soon as one required cite addresses a document the live
    index does not hold (e.g. an insurance item before the corpus expansion).
    """
    return all(cite.document_id in LIVE_INDEXED_DOCUMENT_IDS for cite in item.required_cites)


__all__ = ["LIVE_INDEXED_DOCUMENT_IDS", "is_live_serviceable"]
