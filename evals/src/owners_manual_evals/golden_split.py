"""Deterministic stratified dev/holdout assignment for golden items.

CONTEXT.md ("Dev/holdout split"): a stratified ~70/30 assignment made at
authoring time; iteration touches dev only, holdout runs at release tier, and
the dev-vs-holdout divergence is the overfit detector. "Nothing is trained —
the leak is prompt iteration", so this is not a train/test split: it is a fixed,
reproducible partition that seals a holdout from prompt iteration.

The assignment is:

* **Stratified by behavior class** — each class is split independently so every
  class is represented on both sides (issue #30 AC 4).
* **Deterministic** — parents are ordered within a stratum by a stable digest of
  their id, not by input order or lexical id, so the same set always yields the
  same partition regardless of how the YAML happened to be ordered.
* **~70/30** — the first ``round(0.7 * n)`` parents of each stratum go to dev.
* **Paraphrase-inheriting** — only parent items participate in the split;
  paraphrase variants inherit their parent's side, so a variant never lands on
  the opposite side from the item it is a robustness delta against.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from typing import Literal

from .golden_item import GoldenItem

Side = Literal["dev", "holdout"]

#: Fraction of each stratum's parent items assigned to the dev side.
_DEV_FRACTION = 0.7


def assign_split(items: Iterable[GoldenItem]) -> dict[str, Side]:
    """Assign every item a dev/holdout :data:`Side`.

    Parents (items with no ``paraphrase_of``) are split per behavior class at
    ~70/30, ordered deterministically by a digest of their id. Paraphrase
    variants inherit the side of the parent they name. The result maps every
    item id to its side and is independent of the input ordering.
    """
    materialized = tuple(items)
    parents = tuple(item for item in materialized if item.paraphrase_of is None)

    sides: dict[str, Side] = {}
    for stratum in _strata(parents).values():
        ordered = sorted(stratum, key=_ordering_key)
        dev_count = _dev_count(len(ordered))
        for index, item in enumerate(ordered):
            sides[item.id] = "dev" if index < dev_count else "holdout"

    for item in materialized:
        if item.paraphrase_of is not None:
            sides[item.id] = sides[item.paraphrase_of]

    return sides


def _strata(parents: Iterable[GoldenItem]) -> dict[str, list[GoldenItem]]:
    strata: dict[str, list[GoldenItem]] = {}
    for item in parents:
        strata.setdefault(item.behavior_class, []).append(item)
    return strata


def _dev_count(n: int) -> int:
    """Number of a stratum's ``n`` parents assigned to dev: round-half-up of
    ``0.7 * n``. For n=10 this is 7; for n=3 it is 2."""
    return int(n * _DEV_FRACTION + 0.5)


def _ordering_key(item: GoldenItem) -> str:
    """A stable per-item ordering key: the SHA-256 of the item id. Decouples the
    split from lexical id naming so renaming an unrelated item does not reshuffle
    membership, while staying fully reproducible."""
    return hashlib.sha256(item.id.encode("utf-8")).hexdigest()


__all__ = ["Side", "assign_split"]
