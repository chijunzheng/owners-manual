"""Oracle corpus routing for the ``stuff-oracle`` arm (issue #18).

``stuff-oracle`` isolates the Planner's routing lift from within-corpus retrieval
(CONTEXT.md, "Stuffing baseline"): the oracle is GIVEN the relevant corpora rather
than retrieving them. The ground-truth routing comes from a golden item's required
cites — the documents the answer must pin map to their corpora — so the oracle
knows exactly which corpora a correct answer draws on, which is the upper bound the
Planner's learned routing is measured against.

The ``documentId → corpus`` map mirrors the TS parser registries (CORPUS_SOURCES /
FIXTURE_SOURCES, whose ``file`` path's first segment is the corpus). A refusal item
carries no required cites and therefore routes to no corpus; the caller treats that
as "nothing to route on" and falls back to the full corpus for that item.
"""

from __future__ import annotations

from .golden_item import GoldenItem

#: The four canonical corpus tags, in fixed canonical order (CONTEXT.md).
CORPORA: tuple[str, ...] = ("tenancy", "insurance", "governing", "selling")

#: ``documentId → corpus``, mirroring the TS registries' folder layout. Extending
#: the corpus means adding entries here (and to the TS side) in lockstep.
_DOCUMENT_CORPUS: dict[str, str] = {
    "rta-2006": "tenancy",
    "reg-516-06": "tenancy",
    "ltb-guideline-01": "tenancy",
    "ltb-guideline-05": "tenancy",
    "ltb-guideline-06": "tenancy",
    "ltb-guideline-07": "tenancy",
    "ltb-guideline-11": "tenancy",
    "ltb-guideline-12": "tenancy",
    "ltb-guideline-14": "tenancy",
    "rent-increase-guideline": "tenancy",
    "fixture-lease": "tenancy",
    "condo-act-1998": "governing",
    "reg-48-01": "governing",
    "fixture-declaration": "governing",
    "fixture-rules": "governing",
    "fixture-management-policies": "governing",
    "fixture-master-policy": "insurance",
    "fixture-unit-policy": "insurance",
}


def corpus_of_document_id(document_id: str) -> str:
    """The corpus a document belongs to. Raises ``ValueError`` for an unknown id —
    a cite into an unmapped document is a build bug, not a silent mis-route."""
    corpus = _DOCUMENT_CORPUS.get(document_id)
    if corpus is None:
        raise ValueError(f"no corpus mapping for document id {document_id!r}")
    return corpus


def oracle_corpora_for_item(item: GoldenItem) -> tuple[str, ...]:
    """The corpora the oracle routes an item to: the corpora of its required cites,
    deduped and returned in canonical corpus order. Empty for a refusal item with
    no required cites (nothing to route on)."""
    present = {corpus_of_document_id(cite.document_id) for cite in item.required_cites}
    return tuple(corpus for corpus in CORPORA if corpus in present)


__all__ = ["CORPORA", "corpus_of_document_id", "oracle_corpora_for_item"]
