"""Eval tiers and holdout enforcement (issue #20 AC4).

CONTEXT.md ("Eval gate") tiers the suite — smoke (per merge), full (nightly /
per-release), release (baseline matrix) — and ("Dev/holdout split") seals the
holdout: "Iteration and failure reading touch dev only; holdout runs at release
tier." The holdout is the overfit detector, and its whole value depends on never
having been read during iteration; so it must be UNRUNNABLE outside the release
tier, enforced by construction rather than left to a default flag a caller can
flip by accident.

This module is the single gate. The dev/holdout partitioning itself stays in
:mod:`run_naive_rag` (:func:`select_run_items`, over the deterministic
:mod:`golden_split`); here we only decide whether a tier is permitted to unseal
the holdout, and raise if a non-release tier asks for it.
"""

from __future__ import annotations

from enum import Enum

from .golden_item import GoldenItem
from .golden_loader import GoldenSet
from .run_naive_rag import select_run_items


class Tier(Enum):
    """The eval tiers (CONTEXT.md, "Eval gate"), in ascending coverage.

    Only :attr:`RELEASE` may run the sealed holdout — smoke and full are
    iteration-facing and see dev only.
    """

    SMOKE = "smoke"
    FULL = "full"
    RELEASE = "release"


def holdout_allowed(tier: Tier) -> bool:
    """True only for the release tier — the one tier permitted to unseal holdout."""
    return tier is Tier.RELEASE


def select_tier_items(
    golden: GoldenSet,
    *,
    tier: Tier,
    include_holdout: bool,
) -> tuple[GoldenItem, ...]:
    """The verified items to run for ``tier``, with the holdout tier-gated.

    Dev items run at every tier. Holdout items run ONLY at :attr:`Tier.RELEASE`:
    requesting ``include_holdout`` at any other tier raises ``ValueError`` rather
    than silently dropping it, so a run can never quietly differ from what the
    caller asked for. ``include_holdout=False`` is always honored at every tier.
    """
    if include_holdout and not holdout_allowed(tier):
        raise ValueError(
            f"holdout items run only at the release tier; tier {tier.value!r} is "
            "iteration-facing and sees the dev split only (CONTEXT.md, Dev/holdout split)"
        )
    return select_run_items(golden, include_holdout=include_holdout)


__all__ = ["Tier", "holdout_allowed", "select_tier_items"]
