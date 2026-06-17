"""Offline retrieval for the hybrid-vs-vector-only comparison (#14).

The production retrieval is the TypeScript service (ADR 0003: the harness reads
it as a black box). This module is the harness's OFFLINE stand-in so the
hybrid-vs-vector-only hit-rate comparison is a real, reproducible number in CI
over the committed fixture chunks — no cluster, no network.

Two arms run over the IDENTICAL corpus and query; the only difference is the
fusion of a lexical stage:

  * ``retrieve_vector_only`` ranks by a DETERMINISTIC dense-similarity proxy —
    character-trigram cosine. It is content-based and never inspects the golden
    answer, so it is an honest stand-in for "semantic similarity that misses
    exact legal terms"; it is NOT the production embedding (Voyage), which only
    the live service has.
  * ``retrieve_hybrid`` fuses that dense ranking with a BM25 lexical ranking
    (:func:`bm25_rank`) by RRF (:func:`fuse_by_rrf`), tagging each candidate with
    stage-provenance exactly as the TS hybrid path does.

The point of the comparison is the lexical stage: an exact legal term ("void",
"deposit") that the dense proxy buries can be rescued by BM25 — the mechanism the
hit-rate delta measures. The numbers come out however they come out.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

from .bm25 import Bm25Document, bm25_rank, tokenize
from .rrf import RankedList, fuse_by_rrf

#: Per-stage over-fetch before fusion (mirrors the TS hybrid default).
_PER_STAGE_FACTOR = 3

#: Explicit document-id -> authority level, mirroring the TS ``authority.ts``
#: ``EXPLICIT_LEVELS`` map (#41). The offline stand-in keeps its own copy because
#: it cannot import the TypeScript module; the live executors are the source of
#: truth and the cross-language conformance is asserted by parity tests. Open
#: ``ltb-guideline-*`` ids are classified by prefix below, exactly as in TS.
_EXPLICIT_LEVELS: dict[str, str] = {
    "rta-2006": "act",
    "condo-act-1998": "act",
    "reg-516-06": "regulation",
    "reg-48-01": "regulation",
    "fixture-declaration": "declaration",
    "fixture-rules": "rule",
    "fixture-management-policies": "rule",
    "fixture-lease": "contract",
    "fixture-master-policy": "contract",
    "fixture-unit-policy": "contract",
}


def _authority_level_of(document_id: str) -> str:
    """The authority level of a document id (mirror of TS ``authorityLevelOf``).

    LTB interpretation guidelines match their ``ltb-guideline-*`` family prefix;
    every other source is mapped explicitly. Raises for an unknown id rather than
    guessing — a silently mis-ranked source is a correctness bug, not a shrug.
    """
    explicit = _EXPLICIT_LEVELS.get(document_id)
    if explicit is not None:
        return explicit
    if document_id.startswith("ltb-guideline-"):
        return "guideline"
    raise ValueError(f'unknown document id "{document_id}" — cannot assign an authority level')


def document_ids_for_authority_levels(
    authority_levels: Iterable[str], known_document_ids: Iterable[str]
) -> tuple[str, ...]:
    """Inverse of :func:`_authority_level_of` (#41), mirroring the TS
    ``documentIdsForAuthorityLevels``: the known ids whose level is one of
    ``authority_levels``, deduplicated and in first-seen order. The known-id set
    is supplied by the caller because the open ``ltb-guideline-*`` family has no
    closed list to invert; a known id that cannot be classified raises."""
    wanted = set(authority_levels)
    allow: list[str] = []
    seen: set[str] = set()
    for document_id in known_document_ids:
        if document_id in seen:
            continue
        seen.add(document_id)
        if _authority_level_of(document_id) in wanted:
            allow.append(document_id)
    return tuple(allow)


def _pre_filtered_corpus(
    corpus: Sequence[RetrievalDoc], authority_levels: Sequence[str] | None
) -> Sequence[RetrievalDoc]:
    """Apply the #41 authority PRE-filter: restrict the corpus to documents at the
    requested levels BEFORE ranking, the offline parity of pushing the filter into
    ``$vectorSearch.filter`` / the ``$search`` compound. ``None`` (no filter) and an
    empty list (a no-op, never a drop-everything) both leave the corpus untouched —
    mirroring the live builders, where an empty allow-list emits no filter."""
    if not authority_levels:
        return corpus
    known = tuple(doc.document_id for doc in corpus)
    allow = set(document_ids_for_authority_levels(authority_levels, known))
    return tuple(doc for doc in corpus if doc.document_id in allow)


@dataclass(frozen=True, slots=True)
class RetrievalDoc:
    """One indexed chunk: its document, citable path key, and embeddable text."""

    document_id: str
    citable_path_key: str
    text: str


@dataclass(frozen=True, slots=True)
class OfflineCandidate:
    """A retrieved candidate with fusion provenance, ready for the hit-rate metric."""

    document_id: str
    citable_path_key: str
    score: float
    stage: str
    stages: tuple[str, ...]
    stage_ranks: dict[str, int]


def _trigrams(text: str) -> Counter[str]:
    """Character trigrams of the lowercased alphanumeric token stream."""
    joined = " ".join(tokenize(text))
    if len(joined) < 3:
        return Counter([joined]) if joined else Counter()
    return Counter(joined[i : i + 3] for i in range(len(joined) - 2))


def _cosine(a: Counter[str], b: Counter[str]) -> float:
    """Cosine similarity of two trigram bags (0.0 when either is empty)."""
    if not a or not b:
        return 0.0
    dot = sum(count * b.get(gram, 0) for gram, count in a.items())
    norm_a = sum(count * count for count in a.values()) ** 0.5
    norm_b = sum(count * count for count in b.values()) ** 0.5
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def _dense_ranking(query: str, corpus: Sequence[RetrievalDoc], top_k: int) -> list[str]:
    """Path keys ranked by trigram-cosine to the query, descending, positive only."""
    q = _trigrams(query)
    scored = [(doc.citable_path_key, _cosine(q, _trigrams(doc.text))) for doc in corpus]
    scored = [(key, score) for key, score in scored if score > 0]
    scored.sort(key=lambda pair: (-pair[1], pair[0]))
    return [key for key, _score in scored[:top_k]]


def _bm25_ranking(query: str, corpus: Sequence[RetrievalDoc], top_k: int) -> list[str]:
    """Path keys ranked by BM25 over the corpus text."""
    hits = bm25_rank(
        query=query,
        corpus=tuple(Bm25Document(id=doc.citable_path_key, text=doc.text) for doc in corpus),
        top_k=top_k,
    )
    return [hit.id for hit in hits]


def retrieve_vector_only(
    *,
    query: str,
    corpus: Sequence[RetrievalDoc],
    top_k: int,
    authority_levels: Sequence[str] | None = None,
) -> tuple[OfflineCandidate, ...]:
    """Rank by the dense proxy alone; every candidate is tagged ``vector``.

    When ``authority_levels`` is given, the corpus is PRE-filtered to documents at
    those levels before ranking (#41) — the offline parity of the live
    ``$vectorSearch.filter`` pre-filter, so a higher-authority chunk is never
    crowded out of the top-k by disallowed documents.
    """
    if not query.strip() or not corpus:
        return ()
    corpus = _pre_filtered_corpus(corpus, authority_levels)
    if not corpus:
        return ()
    by_key = {doc.citable_path_key: doc for doc in corpus}
    ranking = _dense_ranking(query, corpus, top_k)
    return tuple(
        OfflineCandidate(
            document_id=by_key[key].document_id,
            citable_path_key=key,
            score=1.0 / (rank + 1),
            stage="vector",
            stages=("vector",),
            stage_ranks={"vector": rank + 1},
        )
        for rank, key in enumerate(ranking)
    )


def retrieve_hybrid(
    *,
    query: str,
    corpus: Sequence[RetrievalDoc],
    top_k: int,
    authority_levels: Sequence[str] | None = None,
) -> tuple[OfflineCandidate, ...]:
    """Fuse the dense proxy and BM25 by RRF; tag candidates with stage-provenance.

    When ``authority_levels`` is given, the corpus is PRE-filtered to documents at
    those levels before BOTH stages rank (#41) — the offline parity of pushing the
    filter into ``$vectorSearch.filter`` and the ``$search`` compound, so each
    stage's over-fetch window already holds only allowed documents.
    """
    if not query.strip() or not corpus:
        return ()
    corpus = _pre_filtered_corpus(corpus, authority_levels)
    if not corpus:
        return ()
    by_key = {doc.citable_path_key: doc for doc in corpus}
    per_stage_k = max(top_k * _PER_STAGE_FACTOR, top_k)

    dense = _dense_ranking(query, corpus, per_stage_k)
    lexical = _bm25_ranking(query, corpus, per_stage_k)
    fused = fuse_by_rrf(
        (
            RankedList(stage="vector", ids=tuple(dense)),
            RankedList(stage="bm25", ids=tuple(lexical)),
        ),
    )

    candidates: list[OfflineCandidate] = []
    for entry in fused:
        doc = by_key.get(entry.id)
        if doc is None:
            continue
        stages = tuple(sorted(entry.ranks))
        candidates.append(
            OfflineCandidate(
                document_id=doc.document_id,
                citable_path_key=entry.id,
                score=entry.rrf_score,
                stage="hybrid" if len(stages) > 1 else stages[0],
                stages=stages,
                stage_ranks=dict(entry.ranks),
            )
        )
    return tuple(candidates[:top_k])


__all__ = [
    "RetrievalDoc",
    "OfflineCandidate",
    "document_ids_for_authority_levels",
    "retrieve_vector_only",
    "retrieve_hybrid",
]
