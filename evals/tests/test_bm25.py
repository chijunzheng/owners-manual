"""BM25 tests (Python side, #14).

Mirror of ``packages/pipeline/src/bm25.ts``. The harness's OFFLINE hybrid-vs-
vector comparison runs this Okapi BM25 over the committed fixture chunks so the
hit-rate delta is a real, reproducible number in CI. Pins the same contract the
TS suite pins: term overlap beats no overlap, TF saturates, IDF weights rarer
terms higher, an absent term contributes nothing, empties are handled.
"""

from __future__ import annotations

from owners_manual_evals.bm25 import Bm25Document, bm25_rank, tokenize

_CORPUS = (
    Bm25Document(id="pets-void", text="No pet provisions in a tenancy agreement are void."),
    Bm25Document(id="repair", text="The landlord is responsible for the repair of the unit."),
    Bm25Document(id="rent", text="A landlord must give ninety days notice to increase the rent."),
    Bm25Document(id="deposit", text="The rent deposit is applied to the last rent period."),
)


def test_tokenize_lowercases_and_splits_on_non_word() -> None:
    assert tokenize("No-pet PROVISIONS, are void.") == ["no", "pet", "provisions", "are", "void"]


def test_tokenize_blank_is_empty() -> None:
    assert tokenize("   ") == []


def test_ranks_overlapping_document_first() -> None:
    ranked = bm25_rank(query="pet void clause", corpus=_CORPUS, top_k=4)
    assert ranked[0].id == "pets-void"
    for hit in ranked:
        assert hit.score >= 0


def test_honours_top_k() -> None:
    ranked = bm25_rank(query="landlord rent", corpus=_CORPUS, top_k=2)
    assert len(ranked) == 2


def test_omits_zero_overlap_documents() -> None:
    ranked = bm25_rank(query="pet", corpus=_CORPUS, top_k=4)
    assert [r.id for r in ranked] == ["pets-void"]


def test_empty_ranking_when_nothing_overlaps() -> None:
    assert bm25_rank(query="mortgage foreclosure", corpus=_CORPUS, top_k=4) == ()


def test_empty_query_ranks_nothing() -> None:
    assert bm25_rank(query="", corpus=_CORPUS, top_k=4) == ()


def test_empty_corpus_ranks_nothing() -> None:
    assert bm25_rank(query="pet", corpus=(), top_k=4) == ()


def test_term_frequency_saturates() -> None:
    tf = (
        Bm25Document(id="one", text="repair"),
        Bm25Document(id="two", text="repair repair"),
        Bm25Document(id="four", text="repair repair repair repair"),
    )
    ranked = bm25_rank(query="repair", corpus=tf, top_k=3)
    assert [r.id for r in ranked] == ["four", "two", "one"]
    score = {r.id: r.score for r in ranked}
    # diminishing returns: 1->2 gains more than 2->4
    assert (score["two"] - score["one"]) > (score["four"] - score["two"])


def test_idf_weights_rarer_term_higher() -> None:
    rare = bm25_rank(query="deposit", corpus=_CORPUS, top_k=4)[0]
    common = bm25_rank(query="landlord", corpus=_CORPUS, top_k=4)[0]
    assert rare.score > common.score


def test_is_deterministic() -> None:
    a = bm25_rank(query="landlord repair rent", corpus=_CORPUS, top_k=4)
    b = bm25_rank(query="landlord repair rent", corpus=_CORPUS, top_k=4)
    assert a == b
