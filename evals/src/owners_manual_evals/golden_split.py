"""Deterministic stratified dev/holdout assignment for golden items.

CONTEXT.md ("Dev/holdout split"): a stratified ~70/30 assignment made at
authoring time; iteration touches dev only, holdout runs at release tier, and
the dev-vs-holdout divergence is the overfit detector. "Nothing is trained —
the leak is prompt iteration", so this is not a train/test split: it is a fixed,
reproducible partition that seals a holdout from prompt iteration.

The assignment is:

* **Stratified by corpus × behavior class** — each (corpus, behavior class) cell
  is split independently, so every behavior class is represented on both sides
  within every corpus (issue #30 AC 4, generalized for the multi-corpus v1 set,
  #22). v0 was single-corpus, so this degenerated to behavior-class strata; the
  glossary ("by corpus × behavior class") always specified the general form.
* **Deterministic** — parents are ordered within a stratum by a stable digest of
  their id, not by input order or lexical id, so the same set always yields the
  same partition regardless of how the YAML happened to be ordered.
* **~70/30** — the first ``round(0.7 * n)`` parents of each stratum go to dev.
* **Paraphrase-inheriting** — only parent items participate in the split;
  paraphrase variants inherit their parent's side, so a variant never lands on
  the opposite side from the item it is a robustness delta against.
* **Frozen (append-stable, ADR 0007)** — the side of every parent that exists at
  a freeze point is recorded in a committed manifest
  (``evals/fixtures/golden/split-manifest.yaml``) and is thereafter
  authoritative. A sort-and-cut at ``round(0.7 * n)`` is NOT stable as ``n``
  grows: adding one parent to a stratum can shift the cut and push an existing
  parent across the dev/holdout line — silently migrating an already-iterated
  item into the sealed holdout. Freezing forbids that: a listed parent keeps its
  recorded side, and a NEW parent (absent from the manifest) is appended into its
  stratum's remaining dev quota in digest order, defaulting to holdout once the
  quota is full. So growing the set can never evict a frozen item across the
  seal. With an empty manifest the rule reduces exactly to the pure ~70/30
  stratified split above, so the algorithm and the freeze are testable apart.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping
from typing import Literal

from .golden_item import GoldenItem

Side = Literal["dev", "holdout"]

#: Fraction of each stratum's parent items assigned to the dev side.
_DEV_FRACTION = 0.7

#: The committed frozen-assignment manifest, read from the golden fixtures dir.
_MANIFEST_FILENAME = "split-manifest.yaml"


def assign_split(
    items: Iterable[GoldenItem],
    *,
    frozen: Mapping[str, Side] | None = None,
) -> dict[str, Side]:
    """Assign every item a dev/holdout :data:`Side`.

    Parents (items with no ``paraphrase_of``) are split per (corpus, behavior
    class) stratum at ~70/30, ordered deterministically by a digest of their id;
    paraphrase variants inherit the side of the parent they name. The result maps
    every item id to its side and is independent of the input ordering.

    ``frozen`` pins parents to a recorded side (ADR 0007): a parent present in
    the mapping keeps that side, and the new (unlisted) parents fill each
    stratum's remaining dev quota in digest order, defaulting to holdout — so
    growing the set never moves a frozen item across the seal. ``frozen``
    defaults to the committed manifest (the safe default — every caller sees the
    sealed partition); pass ``{}`` for the pure, unfrozen stratified split, or an
    explicit mapping to test the freeze.
    """
    if frozen is None:
        frozen = load_frozen_sides()

    materialized = tuple(items)
    parents = tuple(item for item in materialized if item.paraphrase_of is None)

    sides: dict[str, Side] = {}
    for stratum in _strata(parents).values():
        sides.update(_assign_stratum(stratum, frozen))

    for item in materialized:
        if item.paraphrase_of is not None:
            sides[item.id] = sides[item.paraphrase_of]

    return sides


def _assign_stratum(stratum: list[GoldenItem], frozen: Mapping[str, Side]) -> dict[str, Side]:
    """Assign one (corpus, behavior class) cell, honoring frozen pins.

    Frozen parents keep their recorded side and are never moved. The cell's dev
    quota is ``round(0.7 * n)`` over all its parents; whatever the frozen parents
    do not already fill is offered to the NEW (unfrozen) parents in digest order,
    and the rest go to holdout. With no frozen parents this is exactly the plain
    "first ``round(0.7 * n)`` by digest → dev" split.
    """
    ordered = sorted(stratum, key=_ordering_key)
    dev_quota = _dev_count(len(ordered))

    frozen_dev = sum(1 for item in ordered if frozen.get(item.id) == "dev")
    remaining_dev = max(0, dev_quota - frozen_dev)

    sides: dict[str, Side] = {}
    new_rank = 0
    for item in ordered:
        pinned = frozen.get(item.id)
        if pinned is not None:
            sides[item.id] = pinned
            continue
        sides[item.id] = "dev" if new_rank < remaining_dev else "holdout"
        new_rank += 1
    return sides


def load_frozen_sides() -> dict[str, Side]:
    """Read the committed frozen-assignment manifest (ADR 0007).

    Returns the recorded ``{parent id: side}`` map, or an empty map when no
    manifest is present — which makes :func:`assign_split` fall back to the pure
    stratified split. The fixtures locator is imported lazily so importing this
    module needs none of the fixture machinery.
    """
    from .golden_fixtures import resolve_fixtures_dir  # noqa: PLC0415

    path = resolve_fixtures_dir() / _MANIFEST_FILENAME
    if not path.exists():
        return {}

    import yaml  # noqa: PLC0415

    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    recorded = raw.get("sides") or {}
    sides: dict[str, Side] = {}
    for item_id, side in recorded.items():
        if side not in ("dev", "holdout"):
            raise ValueError(
                f"split manifest {path} maps {item_id!r} to invalid side {side!r}; "
                "every recorded side must be 'dev' or 'holdout'."
            )
        sides[str(item_id)] = side
    return sides


def _strata(parents: Iterable[GoldenItem]) -> dict[tuple[str, str], list[GoldenItem]]:
    """Group parents into (corpus, behavior class) cells. Each cell is split
    independently, so the holdout always carries every behavior class within
    every corpus — the overfit detector v1's per-corpus slices need."""
    strata: dict[tuple[str, str], list[GoldenItem]] = {}
    for item in parents:
        strata.setdefault((item.corpus, item.behavior_class), []).append(item)
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


__all__ = ["Side", "assign_split", "load_frozen_sides"]
