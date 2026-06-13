"""Reciprocal Rank Fusion tests (Python side, #14).

Mirror of ``packages/pipeline/src/rrf.ts``. Fuses the vector and BM25 rankings
into one order for the offline comparison. Score-free: uses each id's RANK in
each list, so the two incommensurable scales never need normalizing. Pins the
same contract the TS suite pins.
"""

from __future__ import annotations

from owners_manual_evals.rrf import RRF_K_DEFAULT, RankedList, fuse_by_rrf

_VECTOR = RankedList(stage="vector", ids=("a", "b", "c"))
_BM25 = RankedList(stage="bm25", ids=("b", "d", "a"))


def test_scores_sum_of_reciprocal_ranks() -> None:
    fused = fuse_by_rrf((_VECTOR, _BM25), k=60)
    score = {f.id: f.rrf_score for f in fused}
    assert abs(score["a"] - (1 / 61 + 1 / 63)) < 1e-12
    assert abs(score["b"] - (1 / 62 + 1 / 61)) < 1e-12
    assert abs(score["c"] - (1 / 63)) < 1e-12
    assert abs(score["d"] - (1 / 62)) < 1e-12


def test_agreement_outranks_single_list_strength() -> None:
    fused = fuse_by_rrf((_VECTOR, _BM25), k=60)
    assert fused[0].id == "b"  # ranked by both stages


def test_preserves_per_stage_provenance() -> None:
    fused = fuse_by_rrf((_VECTOR, _BM25), k=60)
    a = next(f for f in fused if f.id == "a")
    assert a.ranks == {"vector": 1, "bm25": 3}
    c = next(f for f in fused if f.id == "c")
    assert c.ranks == {"vector": 3}


def test_descending_score_order() -> None:
    fused = fuse_by_rrf((_VECTOR, _BM25), k=60)
    scores = [f.rrf_score for f in fused]
    assert scores == sorted(scores, reverse=True)


def test_ties_broken_by_id() -> None:
    left = RankedList(stage="vector", ids=("zeta",))
    right = RankedList(stage="bm25", ids=("alpha",))
    fused = fuse_by_rrf((left, right), k=60)
    assert [f.id for f in fused] == ["alpha", "zeta"]


def test_union_of_ids_for_disjoint_lists() -> None:
    left = RankedList(stage="vector", ids=("a", "b"))
    right = RankedList(stage="bm25", ids=("c", "d"))
    fused = fuse_by_rrf((left, right), k=60)
    assert {f.id for f in fused} == {"a", "b", "c", "d"}


def test_empty_input_fuses_to_empty() -> None:
    assert fuse_by_rrf((), k=60) == ()


def test_ignores_empty_lists() -> None:
    fused = fuse_by_rrf((_VECTOR, RankedList(stage="bm25", ids=())), k=60)
    assert [f.id for f in fused] == ["a", "b", "c"]


def test_default_k() -> None:
    assert RRF_K_DEFAULT == 60
    assert fuse_by_rrf((_VECTOR, _BM25)) == fuse_by_rrf((_VECTOR, _BM25), k=RRF_K_DEFAULT)
