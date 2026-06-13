"""BM25 — the lexical half of the offline hybrid-vs-vector comparison (#14).

Mirror of ``packages/pipeline/src/bm25.ts``. The production BM25 stage is Atlas
``$search``; this Python port exists so the harness can run a REAL, reproducible
hybrid-vs-vector-only hit-rate comparison over the committed fixture chunks in
CI, without a cluster. It is the same standard Okapi BM25 (``k1 = 1.5``,
``b = 0.75``): term frequency saturates, document length is normalized against
the corpus average, and IDF weights rarer query terms higher. A term absent from
the corpus contributes zero (no division blow-up).
"""

from __future__ import annotations

import math
import re
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass

_K1_DEFAULT = 1.5
_B_DEFAULT = 0.75
_NON_WORD = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True, slots=True)
class Bm25Document:
    """One document in the BM25 corpus: a stable id and its text."""

    id: str
    text: str


@dataclass(frozen=True, slots=True)
class Bm25Hit:
    """A scored BM25 hit: the document id and its non-negative BM25 score."""

    id: str
    score: float


def tokenize(text: str) -> list[str]:
    """Lowercase a string and split it into word tokens (non-word chars split)."""
    return [token for token in _NON_WORD.split(text.lower()) if token]


def _idf(document_count: int, docs_with_term: int) -> float:
    """BM25's smoothed IDF (always > 0 for a corpus of n > 0)."""
    return math.log(1 + (document_count - docs_with_term + 0.5) / (docs_with_term + 0.5))


def bm25_rank(
    *,
    query: str,
    corpus: Sequence[Bm25Document],
    top_k: int,
    k1: float = _K1_DEFAULT,
    b: float = _B_DEFAULT,
) -> tuple[Bm25Hit, ...]:
    """Rank the corpus against the query by BM25.

    Returns the top-k hits with a positive score, descending (ties broken by id
    for determinism). Documents with no query-term overlap are omitted.
    """
    query_terms = set(tokenize(query))
    if not query_terms or not corpus:
        return ()

    tokenized = [(doc.id, tokenize(doc.text)) for doc in corpus]
    total_length = sum(len(tokens) for _id, tokens in tokenized)
    avg_length = total_length / len(tokenized) if tokenized else 0.0

    doc_freq: dict[str, int] = {}
    for term in query_terms:
        doc_freq[term] = sum(1 for _id, tokens in tokenized if term in tokens)

    hits: list[Bm25Hit] = []
    for doc_id, tokens in tokenized:
        length = len(tokens)
        term_counts = Counter(token for token in tokens if token in query_terms)
        if not term_counts:
            continue
        score = 0.0
        for term, freq in term_counts.items():
            df = doc_freq.get(term, 0)
            if df == 0:
                continue
            numerator = freq * (k1 + 1)
            denominator = freq + k1 * (1 - b + (b * length) / (avg_length or 1))
            score += _idf(len(corpus), df) * (numerator / denominator)
        if score > 0:
            hits.append(Bm25Hit(id=doc_id, score=score))

    hits.sort(key=lambda hit: (-hit.score, hit.id))
    return tuple(hits[:top_k])


__all__ = ["Bm25Document", "Bm25Hit", "tokenize", "bm25_rank"]
