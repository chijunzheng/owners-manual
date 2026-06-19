"""The Python fixture-design id mirror stays in lockstep with the TS source.

Source of truth: ``packages/parser/src/fixtures.ts`` (``FIXTURE_DESIGN_IDS``).
Python cannot import the TS module, so this test READS that file and derives the
expected ids from it — a real cross-language drift guard, not a second hand-typed
copy of the list. The moment the registries diverge (an id added or removed on
the TS side without updating the Python mirror), this fails, so the parser can
never silently reject a newly-valid ``tags.fixture`` or accept a stale one.
"""

from __future__ import annotations

import re
from pathlib import Path

from owners_manual_evals.fixture_design import FIXTURE_DESIGN_ID_SET, FIXTURE_DESIGN_IDS


def _ts_fixture_design_ids() -> tuple[str, ...]:
    """Extract ``FIXTURE_DESIGN_IDS`` from the TS source of truth, in file order.

    Walks up from this test to the monorepo's ``packages/parser/src/fixtures.ts``
    and pulls the single-quoted ids out of the ``FIXTURE_DESIGN_IDS = [...] as
    const`` array. Fails loudly if the file is absent — the mirror's source of
    truth must be present for the guard to mean anything.
    """
    for ancestor in Path(__file__).resolve().parents:
        candidate = ancestor / "packages" / "parser" / "src" / "fixtures.ts"
        if candidate.is_file():
            text = candidate.read_text(encoding="utf-8")
            break
    else:
        raise AssertionError(
            "could not locate packages/parser/src/fixtures.ts above "
            f"{Path(__file__).resolve()}; the fixture-design source of truth must be "
            "present for the lockstep guard to run"
        )
    array = re.search(r"FIXTURE_DESIGN_IDS\s*=\s*\[(.*?)\]\s*as const", text, re.DOTALL)
    assert array is not None, "FIXTURE_DESIGN_IDS array not found in fixtures.ts"
    return tuple(re.findall(r"'([^']+)'", array.group(1)))


def test_python_mirror_matches_the_ts_source_of_truth() -> None:
    # Order-sensitive: both registries declare a canonical order.
    assert FIXTURE_DESIGN_IDS == _ts_fixture_design_ids()


def test_id_set_matches_the_tuple_with_no_duplicates() -> None:
    assert FIXTURE_DESIGN_ID_SET == frozenset(FIXTURE_DESIGN_IDS)
    assert len(FIXTURE_DESIGN_ID_SET) == len(FIXTURE_DESIGN_IDS)
