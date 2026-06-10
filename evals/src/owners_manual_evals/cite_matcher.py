"""The hierarchical cite matcher (Python side).

Mirror of ``packages/core/src/cite-matcher.ts``. Cite grading is hierarchical
via citable paths (README, "Evaluation"): an answer citing s. 49(1)(a)
satisfies a required s. 49 — a descendant covers its ancestor — while a bare
s. 49 cited against a required subsection scores partial. This is the metric
the Python grader applies to golden-set required cites; it must return the same
verdict as the TypeScript library for every committed conformance vector.

A candidate is first *resolved* against the known document trees. A candidate
addressing no real node is ``unresolvable``. A resolvable candidate is graded
against the requirement: identical -> ``exact``; strictly below the requirement
-> ``descendant-satisfies-ancestor``; strictly above -> ``ancestor-partial``;
otherwise (sibling / cousin / cross-document) -> ``no-match``.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Literal

from .citable_path import (
    CitablePath,
    citable_paths_equal,
    is_proper_ancestor,
    is_proper_descendant,
)
from .document_tree import DocumentTree, walk_tree

CiteVerdict = Literal[
    "exact",
    "descendant-satisfies-ancestor",
    "ancestor-partial",
    "no-match",
    "unresolvable",
]

#: The closed set of verdicts the matcher can return, ordered strongest-first.
CITE_VERDICTS: tuple[CiteVerdict, ...] = (
    "exact",
    "descendant-satisfies-ancestor",
    "ancestor-partial",
    "no-match",
    "unresolvable",
)


def resolves_to_node(path: CitablePath, documents: Iterable[DocumentTree]) -> bool:
    """True when ``path`` addresses a real node in one of ``documents``."""
    tree = next((doc for doc in documents if doc.document_id == path.document_id), None)
    if tree is None:
        return False
    resolved = False

    def visit(_node, node_path: CitablePath) -> None:
        nonlocal resolved
        if not resolved and citable_paths_equal(node_path, path):
            resolved = True

    walk_tree(tree, visit)
    return resolved


def match_cite(
    *,
    required: CitablePath,
    candidate: CitablePath,
    documents: Sequence[DocumentTree],
) -> CiteVerdict:
    """Grade ``candidate`` against ``required``, resolving the candidate against
    the supplied document trees. Returns exactly one :data:`CiteVerdict`."""
    if not resolves_to_node(candidate, documents):
        return "unresolvable"
    if citable_paths_equal(candidate, required):
        return "exact"
    if is_proper_descendant(candidate, required):
        return "descendant-satisfies-ancestor"
    if is_proper_ancestor(candidate, required):
        return "ancestor-partial"
    return "no-match"


def satisfies_requirement(verdict: CiteVerdict) -> bool:
    """True when a candidate fully satisfies a required cite (exact or descendant)."""
    return verdict in ("exact", "descendant-satisfies-ancestor")


__all__ = [
    "CiteVerdict",
    "CITE_VERDICTS",
    "resolves_to_node",
    "match_cite",
    "satisfies_requirement",
]
