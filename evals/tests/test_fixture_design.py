"""The Python fixture-design id mirror stays in lockstep with the TS source.

Source of truth: ``packages/parser/src/fixtures.ts`` (``FIXTURE_DESIGN_IDS``).
Python cannot import the TS module, so this pins the hand-mirrored copy — the
same by-hand-plus-test contract ``oracle.py`` keeps with the corpus registries.
"""

from owners_manual_evals.fixture_design import FIXTURE_DESIGN_ID_SET, FIXTURE_DESIGN_IDS


def test_mirrors_the_seventeen_planted_conflict_ids() -> None:
    assert FIXTURE_DESIGN_IDS == (
        "INS-01",
        "INS-02",
        "INS-03",
        "LEASE-01",
        "LEASE-02",
        "LEASE-03",
        "LEASE-04",
        "LEASE-05",
        "LEASE-06",
        "LEASE-07",
        "LEASE-08",
        "GOV-01",
        "GOV-02",
        "GOV-03",
        "GOV-04",
        "GOV-05",
        "GOV-06",
    )


def test_id_set_matches_the_tuple_with_no_duplicates() -> None:
    assert FIXTURE_DESIGN_ID_SET == frozenset(FIXTURE_DESIGN_IDS)
    assert len(FIXTURE_DESIGN_ID_SET) == len(FIXTURE_DESIGN_IDS)
