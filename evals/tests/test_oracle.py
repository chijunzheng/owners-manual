"""Oracle corpus-routing tests (issue #18).

``stuff-oracle`` isolates the Planner's routing lift: the oracle is GIVEN the
relevant corpora, derived from the golden item's required cites (the documents the
answer must pin → their corpora). This is the ground-truth routing the harness
feeds the ``/stuff-oracle`` route. A refusal item with no required cites routes to
no corpus — the harness falls back to the full corpus (it is `stuff` for that
item, since there is nothing to route on).
"""

from __future__ import annotations

from owners_manual_evals.citable_path import CitablePath, CitablePathSegment
from owners_manual_evals.golden_item import AnswerPoint, GoldenItem, Provenance
from owners_manual_evals.oracle import corpus_of_document_id, oracle_corpora_for_item


def _item(document_ids: list[str], *, behavior: str) -> GoldenItem:
    """Build a GoldenItem directly (bypassing cite resolution) for routing tests."""
    return GoldenItem(
        id="x",
        behavior_class=behavior,  # type: ignore[arg-type]
        verified=True,
        question="q",
        answer_points=(AnswerPoint(id="p", text="t"),),
        required_cites=tuple(
            CitablePath(document_id=d, segments=(CitablePathSegment("section", "1"),))
            for d in document_ids
        ),
        provenance=Provenance(source="x", reference="y"),
    )


def test_corpus_of_document_id_maps_the_golden_v0_documents() -> None:
    assert corpus_of_document_id("rta-2006") == "tenancy"
    assert corpus_of_document_id("reg-516-06") == "tenancy"
    assert corpus_of_document_id("fixture-lease") == "tenancy"
    assert corpus_of_document_id("fixture-declaration") == "governing"


def test_corpus_of_document_id_rejects_an_unknown_document() -> None:
    try:
        corpus_of_document_id("mystery-doc")
    except ValueError as error:
        assert "mystery-doc" in str(error)
    else:  # pragma: no cover
        raise AssertionError("expected a ValueError for an unknown document id")


def test_oracle_routes_a_single_corpus_item_to_its_corpus() -> None:
    assert oracle_corpora_for_item(_item(["rta-2006"], behavior="answer")) == ("tenancy",)


def test_oracle_routes_a_cross_corpus_item_to_all_its_corpora_deduped_in_order() -> None:
    item = _item(["rta-2006", "fixture-lease", "fixture-declaration"], behavior="flag-void-clause")
    # tenancy (rta + lease) then governing (declaration), deduped, canonical order.
    assert oracle_corpora_for_item(item) == ("tenancy", "governing")


def test_oracle_returns_empty_for_a_refusal_item_with_no_cites() -> None:
    assert oracle_corpora_for_item(_item([], behavior="refuse-jurisdiction")) == ()
