"""Offline-retrieval tests (#14).

The offline retrieval runs two arms over the committed fixture chunks so the
hybrid-vs-vector-only hit-rate comparison is a real, reproducible number in CI
(no cluster). Both arms see the IDENTICAL corpus and query; the only difference
is that the hybrid arm fuses the dense ranking with a BM25 lexical ranking by
RRF. The dense ranking is a deterministic, content-based proxy (character n-gram
cosine) — it never peeks at the answer, so a hybrid win or loss is honest.

Pinned contract:
  * a vector-only run returns candidates tagged ``vector`` only;
  * a hybrid run fuses vector + BM25 and tags multi-stage candidates ``hybrid``;
  * lexical exact-term overlap that the dense proxy misses can be rescued by the
    BM25 stage (the mechanism the comparison measures);
  * results are path keys, ready for the hierarchical hit-rate metric.
"""

from __future__ import annotations

import pytest

from owners_manual_evals.offline_retrieval import (
    RetrievalDoc,
    document_ids_for_authority_levels,
    retrieve_hybrid,
    retrieve_vector_only,
)

# A tiny corpus where lexical and dense signals disagree: the "pets" clause uses
# the exact query word "pet"; a distractor shares many characters but not the
# operative term.
_CORPUS = (
    RetrievalDoc(
        document_id="fixture-lease",
        citable_path_key="fixture-lease|section:pets|clause:p-1",
        text="No pets of any kind are permitted in the rental unit.",
    ),
    RetrievalDoc(
        document_id="fixture-lease",
        citable_path_key="fixture-lease|section:renewal|clause:p-1",
        text="The tenant must give sixty days notice to renew the tenancy term.",
    ),
    RetrievalDoc(
        document_id="rta-2006",
        citable_path_key="rta-2006|part:II|section:14",
        text="A provision prohibiting animals in a tenancy agreement is void.",
    ),
)


def test_vector_only_tags_every_candidate_vector() -> None:
    result = retrieve_vector_only(query="pets clause", corpus=_CORPUS, top_k=3)
    assert len(result) > 0
    assert all(c.stage == "vector" for c in result)
    assert all(c.stages == ("vector",) for c in result)


def test_hybrid_fuses_vector_and_bm25() -> None:
    result = retrieve_hybrid(query="pet animals void", corpus=_CORPUS, top_k=3)
    # the no-pets clause and the void-provision section both match lexically
    keys = {c.citable_path_key for c in result}
    assert "fixture-lease|section:pets|clause:p-1" in keys
    assert "rta-2006|part:II|section:14" in keys


def test_hybrid_tags_multi_stage_candidate_hybrid() -> None:
    result = retrieve_hybrid(query="pets", corpus=_CORPUS, top_k=3)
    pets = next(c for c in result if c.citable_path_key == "fixture-lease|section:pets|clause:p-1")
    # found by both the dense proxy and BM25 -> hybrid, with both ranks present
    assert pets.stage == "hybrid"
    assert set(pets.stages) == {"vector", "bm25"}
    assert "vector" in pets.stage_ranks
    assert "bm25" in pets.stage_ranks


def test_bm25_rescues_an_exact_lexical_match_the_dense_proxy_buries() -> None:
    # "void" is an exact lexical hit on s.14 but a weak character-overlap signal;
    # the hybrid arm should surface s.14, and it should rank no worse under
    # hybrid than under vector-only (fusion can only help an exact-term hit).
    query = "is the clause void"
    hybrid = retrieve_hybrid(query=query, corpus=_CORPUS, top_k=3)
    vector = retrieve_vector_only(query=query, corpus=_CORPUS, top_k=3)
    hybrid_keys = [c.citable_path_key for c in hybrid]
    assert "rta-2006|part:II|section:14" in hybrid_keys
    if "rta-2006|part:II|section:14" in [c.citable_path_key for c in vector]:
        v_rank = [c.citable_path_key for c in vector].index("rta-2006|part:II|section:14")
        h_rank = hybrid_keys.index("rta-2006|part:II|section:14")
        assert h_rank <= v_rank


def test_top_k_truncates_both_arms() -> None:
    assert len(retrieve_vector_only(query="tenancy", corpus=_CORPUS, top_k=1)) == 1
    assert len(retrieve_hybrid(query="tenancy", corpus=_CORPUS, top_k=1)) == 1


def test_empty_query_returns_nothing() -> None:
    assert retrieve_vector_only(query="", corpus=_CORPUS, top_k=3) == ()
    assert retrieve_hybrid(query="", corpus=_CORPUS, top_k=3) == ()


def test_deterministic() -> None:
    a = retrieve_hybrid(query="pet void", corpus=_CORPUS, top_k=3)
    b = retrieve_hybrid(query="pet void", corpus=_CORPUS, top_k=3)
    assert a == b


# --- #41: the same authority pre-filter as the live executors, for parity -----------


def test_document_ids_for_authority_levels_inverts_the_classifier() -> None:
    # Mirrors the TS authority.documentIdsForAuthorityLevels: given the requested
    # levels and the corpus's known id set, the allow-list of ids at those levels.
    known = ("rta-2006", "reg-516-06", "fixture-lease", "ltb-guideline-05")
    assert document_ids_for_authority_levels(("act",), known) == ("rta-2006",)
    assert document_ids_for_authority_levels(("act", "regulation"), known) == (
        "rta-2006",
        "reg-516-06",
    )
    assert document_ids_for_authority_levels(("guideline",), known) == ("ltb-guideline-05",)
    assert document_ids_for_authority_levels(("contract",), known) == ("fixture-lease",)


def test_document_ids_for_authority_levels_raises_on_unknown_id() -> None:
    with pytest.raises(ValueError, match="unknown"):
        document_ids_for_authority_levels(("act",), ("totally-unknown",))


def test_authority_filter_keeps_only_allowed_levels_both_arms() -> None:
    # The lease clauses are contract-level; s.14 is act-level. Filtering to act must
    # drop the lease clauses from BOTH arms.
    vector = retrieve_vector_only(
        query="pets void", corpus=_CORPUS, top_k=3, authority_levels=("act",)
    )
    hybrid = retrieve_hybrid(query="pets void", corpus=_CORPUS, top_k=3, authority_levels=("act",))
    assert all(c.document_id == "rta-2006" for c in vector)
    assert all(c.document_id == "rta-2006" for c in hybrid)
    assert {c.document_id for c in hybrid} == {"rta-2006"}


def test_no_authority_filter_keeps_every_document() -> None:
    # Parity with the TS default: no authority_levels means no pre-filter at all.
    hybrid = retrieve_hybrid(query="pets void", corpus=_CORPUS, top_k=3)
    assert {c.document_id for c in hybrid} == {"fixture-lease", "rta-2006"}


def test_pre_filter_rescues_a_high_authority_chunk_crowded_out_offline() -> None:
    # The offline parity of the TS AC3 regression: many contract-level chunks rank
    # above the lone act-level chunk by the dense proxy, pushing it past the
    # per-stage over-fetch window. The pre-filter restricts the corpus to act-level
    # docs FIRST, so the act chunk is ranked and returned instead of being crowded
    # out before any post-filter could see it.
    act_key = "rta-2006|part:II|section:14"
    crowding_corpus = tuple(
        RetrievalDoc(
            document_id="fixture-lease",
            citable_path_key=f"fixture-lease|section:s{n}|clause:p-1",
            text="The tenant agrees to the lease clause about the rental unit terms.",
        )
        for n in range(1, 7)
    ) + (
        RetrievalDoc(
            document_id="rta-2006",
            citable_path_key=act_key,
            text="A provision prohibiting animals in a tenancy agreement is void.",
        ),
    )
    query = "lease clause about the rental unit terms"
    # Without the filter, top_k=2 over a dense ranking dominated by the lease
    # clauses does not surface the act chunk.
    unfiltered = retrieve_hybrid(query=query, corpus=crowding_corpus, top_k=2)
    assert act_key not in {c.citable_path_key for c in unfiltered}
    # With the act-only pre-filter, the act chunk is the only candidate and surfaces.
    filtered = retrieve_hybrid(
        query=query, corpus=crowding_corpus, top_k=2, authority_levels=("act",)
    )
    assert act_key in {c.citable_path_key for c in filtered}
    assert all(c.document_id == "rta-2006" for c in filtered)


def test_empty_authority_filter_is_a_no_op_not_a_drop_everything() -> None:
    # An empty allow-list mirrors the TS no-op: it must not filter the corpus down
    # to nothing (that would be a $in:[] bug), it leaves every document in play.
    hybrid = retrieve_hybrid(query="pets void", corpus=_CORPUS, top_k=3, authority_levels=())
    assert {c.document_id for c in hybrid} == {"fixture-lease", "rta-2006"}
