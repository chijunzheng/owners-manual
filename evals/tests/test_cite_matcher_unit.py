"""Direct unit tests for the matcher helpers, mirroring the TypeScript suite.

The conformance vectors exercise ``match_cite`` end to end; these pin the two
public helpers downstream graders call directly: ``resolves_to_node`` and
``satisfies_requirement``.
"""

from owners_manual_evals.citable_path import CitablePath, CitablePathSegment
from owners_manual_evals.cite_matcher import (
    match_cite,
    resolves_to_node,
    satisfies_requirement,
)
from owners_manual_evals.conformance import load_conformance_vectors

_VECTORS = load_conformance_vectors()
_DOCUMENTS = _VECTORS.documents


def _path(*segments: tuple[str, str], document_id: str = "RTA") -> CitablePath:
    return CitablePath(
        document_id=document_id,
        segments=tuple(CitablePathSegment(kind=kind, label=label) for kind, label in segments),
    )


def test_match_cite_exact_when_identical() -> None:
    path = _path(("section", "62"))
    assert match_cite(required=path, candidate=path, documents=_DOCUMENTS) == "exact"


def test_resolves_to_node_for_a_real_path() -> None:
    assert resolves_to_node(_path(("section", "49"), ("subsection", "1")), _DOCUMENTS)


def test_does_not_resolve_in_an_unknown_document() -> None:
    assert not resolves_to_node(_path(("section", "1"), document_id="NOPE"), _DOCUMENTS)


def test_does_not_resolve_when_overshooting_a_leaf() -> None:
    overshoot = _path(("section", "62"), ("subsection", "1"), ("clause", "a"))
    assert not resolves_to_node(overshoot, _DOCUMENTS)


def test_satisfies_requirement_full_vs_partial() -> None:
    assert satisfies_requirement("exact")
    assert satisfies_requirement("descendant-satisfies-ancestor")
    assert not satisfies_requirement("ancestor-partial")
    assert not satisfies_requirement("no-match")
    assert not satisfies_requirement("unresolvable")
