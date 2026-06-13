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

from owners_manual_evals.offline_retrieval import (
    RetrievalDoc,
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
