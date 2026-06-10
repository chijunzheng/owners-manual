"""Cross-language conformance: the Python matcher must agree with the committed
vector file on every case.

There is ONE vector file — ``packages/core/conformance/cite-matcher-vectors.json``
— and the TypeScript core library and this Python grader both load it. If the
two implementations ever disagree on a verdict, one of these suites goes red in
CI. The verdict categories mirror the README cite-grading paragraph: exact,
descendant-satisfies-ancestor, ancestor-partial, no-match, and unresolvable.
"""

import pytest

from owners_manual_evals.cite_matcher import CITE_VERDICTS, match_cite
from owners_manual_evals.conformance import load_conformance_vectors

_VECTORS = load_conformance_vectors()


def test_every_verdict_is_exercised() -> None:
    covered = {case.expected for case in _VECTORS.cases}
    for verdict in CITE_VERDICTS:
        assert verdict in covered, f"no conformance vector exercises verdict {verdict!r}"


def test_at_least_the_four_required_categories_present() -> None:
    covered = {case.expected for case in _VECTORS.cases}
    for required in ("exact", "descendant-satisfies-ancestor", "ancestor-partial", "unresolvable"):
        assert required in covered


@pytest.mark.parametrize(
    "vector_case",
    _VECTORS.cases,
    ids=[case.id for case in _VECTORS.cases],
)
def test_vector_yields_expected_verdict(vector_case) -> None:
    verdict = match_cite(
        required=vector_case.required,
        candidate=vector_case.candidate,
        documents=_VECTORS.documents,
    )
    assert verdict == vector_case.expected
