"""Eval-tier holdout enforcement tests (issue #20 AC4).

CONTEXT.md ("Dev/holdout split"): "Iteration and failure reading touch dev only;
holdout runs at release tier." and ("Eval gate"): tiers are smoke (per merge),
full (nightly/per-release), release (baseline matrix). The holdout must be
UNRUNNABLE outside the release tier — not merely defaulted off but ENFORCED, so a
caller cannot accidentally leak the overfit detector into iteration.

These pin: holdout is sealed at smoke and full; permitted only at release; the
dev side is always available at every tier; and the enforcement is a raise, not a
silent drop (a silent drop would hide that the run was not what the caller asked
for).
"""

from __future__ import annotations

from owners_manual_evals.eval_tier import Tier, holdout_allowed, select_tier_items
from owners_manual_evals.golden_item import parse_golden_item
from owners_manual_evals.golden_loader import GoldenSet


def _answer_item(item_id: str) -> object:
    return parse_golden_item(
        {
            "id": item_id,
            "behavior_class": "answer",
            "corpus": "tenancy",
            "verified": True,
            "question": f"Q {item_id}",
            "answer_points": [{"id": "p1", "text": "t"}],
            "required_cites": [],
            "provenance": {"source": "behavior-design", "reference": "x"},
        },
        documents=(),
    )


def _refuse_item(item_id: str) -> object:
    return parse_golden_item(
        {
            "id": item_id,
            "behavior_class": "refuse-jurisdiction",
            "corpus": "tenancy",
            "verified": True,
            "question": f"Q {item_id}",
            "answer_points": [{"id": "p1", "text": "t"}],
            "required_cites": [],
            "provenance": {"source": "behavior-design", "reference": "x"},
        },
        documents=(),
    )


def _split_set() -> GoldenSet:
    # Enough parents per class that the stratified split lands some on each side.
    items = [_answer_item(f"a{i}") for i in range(10)] + [_refuse_item(f"r{i}") for i in range(10)]
    return GoldenSet(version=1, items=tuple(items))


def test_holdout_allowed_only_at_the_release_tier() -> None:
    assert holdout_allowed(Tier.RELEASE) is True
    assert holdout_allowed(Tier.SMOKE) is False
    assert holdout_allowed(Tier.FULL) is False


def test_smoke_and_full_tiers_run_dev_only() -> None:
    golden = _split_set()
    smoke_dev = select_tier_items(golden, tier=Tier.SMOKE, include_holdout=False)
    full_dev = select_tier_items(golden, tier=Tier.FULL, include_holdout=False)
    # The dev selection at smoke equals the dev selection at full (tier does not
    # change WHICH dev items run, only whether holdout is permitted at all).
    assert {i.id for i in smoke_dev} == {i.id for i in full_dev}
    assert len(smoke_dev) >= 1
    # And the dev selection is strictly smaller than the whole verified set.
    assert len(smoke_dev) < len(golden.items)


def test_requesting_holdout_outside_release_tier_raises() -> None:
    golden = _split_set()
    for tier in (Tier.SMOKE, Tier.FULL):
        try:
            select_tier_items(golden, tier=tier, include_holdout=True)
        except ValueError as error:
            message = str(error).lower()
            assert "holdout" in message and "release" in message
        else:  # pragma: no cover
            raise AssertionError(f"expected holdout at {tier} to raise")


def test_release_tier_with_holdout_runs_the_whole_set() -> None:
    golden = _split_set()
    release_full = select_tier_items(golden, tier=Tier.RELEASE, include_holdout=True)
    assert len(release_full) == 20


def test_release_tier_without_holdout_still_seals_it() -> None:
    golden = _split_set()
    dev = select_tier_items(golden, tier=Tier.RELEASE, include_holdout=False)
    full = select_tier_items(golden, tier=Tier.RELEASE, include_holdout=True)
    assert len(dev) < len(full)
    assert {i.id for i in dev}.issubset({i.id for i in full})


def test_dev_selection_never_contains_a_holdout_item() -> None:
    from owners_manual_evals.golden_split import assign_split

    golden = _split_set()
    sides = assign_split(golden.items)
    dev = select_tier_items(golden, tier=Tier.SMOKE, include_holdout=False)
    assert all(sides[item.id] == "dev" for item in dev)
