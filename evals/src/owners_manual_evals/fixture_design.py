"""The fixture-design id registry (Python mirror of the TS source of truth).

The planted-conflict ids declared in ``corpus/fixtures/FIXTURE-DESIGN.md`` and
typed in ``packages/parser/src/fixtures.ts`` (``FIXTURE_DESIGN_IDS``). A designed
fixture is a synthetic document authored to plant a specific teachable conflict
(a void clause, a coverage gap, a deductible chargeback); each conflict carries
one of these ids. A golden item built on a fixture names the conflict it
instantiates by id via its ``tags.fixture`` (issue #22), which makes the "items
reference fixture conflicts by ID" acceptance criterion machine-checkable.

This tuple mirrors the TS constant BY HAND — the same lockstep contract
``oracle.py`` keeps with the corpus registries (Python cannot import the TS
module, so each side pins its own copy and a test guards it). Extending the
fixtures means adding ids here and in ``fixtures.ts`` together.
"""

from __future__ import annotations

#: The planted-conflict ids, mirroring ``FIXTURE_DESIGN_IDS`` in fixtures.ts:
#: three insurance conflicts, eight lease conflicts, six governing conflicts.
FIXTURE_DESIGN_IDS: tuple[str, ...] = (
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

#: Frozen set for O(1) membership checks in the golden-item parser.
FIXTURE_DESIGN_ID_SET: frozenset[str] = frozenset(FIXTURE_DESIGN_IDS)

__all__ = ["FIXTURE_DESIGN_IDS", "FIXTURE_DESIGN_ID_SET"]
