"""Stratified seeded sampler for the judge-calibration slice (issue #19, ADR 0010).

CONTEXT.md ("Calibration slice"): ~20 golden items whose answer points a human
grades, so judge–human agreement (Cohen's κ) can be published. ADR 0010 Decision 2
pins HOW the slice is drawn, and this module is the pure sampler that draws it:

* **dev only** — the holdout stays sealed (ADR 0007); rubric-wrong findings edit
  golden items, which may only happen on dev;
* **parents only** — paraphrase variants inherit a parent's behavior and would
  double-count, so they are excluded;
* **stratified by behavior class, floor ≥3 per refusal class** — every refusal
  class (``refuse-jurisdiction``, ``refuse-out-of-scope``, ``refuse-advice-escalate``,
  ``flag-void-clause``) is guaranteed at least the floor WHEN its dev pool allows,
  degrading to "take all there are" when it is smaller; the remainder of the budget
  is drawn from the ``answer`` class (the headline arm's bread-and-butter);
* **ordered by SHA-256(item.id)** — each stratum's pool is canonically ordered by a
  stable digest of the id (the ADR 0007 reproducibility discipline, as in
  :mod:`golden_split`), so the seeded draw is independent of YAML authoring order;
* **seeded, without replacement** — a :class:`random.Random` seeded from the caller
  (never the global RNG) samples within each stratum, extending
  :func:`variance_audit.select_variance_slice`'s discipline to a stratified one.

The selection is frozen in ``evals/fixtures/calibration/slice-manifest.yaml`` via
:func:`render_slice_manifest`; :func:`parse_slice_manifest` reads it back with the
repo's strict-parser philosophy (reject unknown keys, reject a non-dev side).
"""

from __future__ import annotations

import hashlib
import random
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .golden_item import BEHAVIOR_CLASSES, BehaviorClass, GoldenItem
from .golden_split import Side

#: The behavior classes that get a per-class floor on the slice (ADR 0010
#: Decision 2). These are exactly the four non-``answer`` classes — the refusal
#: and void-flagging behaviors whose rubric points are easiest to mis-grade and so
#: most need explicit κ coverage.
REFUSAL_BEHAVIOR_CLASSES: tuple[BehaviorClass, ...] = tuple(
    cls for cls in BEHAVIOR_CLASSES if cls != "answer"
)

#: The behavior class the slice's remainder is drawn from once the floors are met.
_REMAINDER_BEHAVIOR_CLASS: BehaviorClass = "answer"

#: ADR 0010 Decision 2 targets ~20 items with a floor of ≥3 per refusal class.
DEFAULT_CALIBRATION_SLICE_SIZE = 20
DEFAULT_REFUSAL_FLOOR = 3

#: The committed slice manifest filename, under the calibration fixtures dir.
SLICE_MANIFEST_FILENAME = "slice-manifest.yaml"

#: The keys a slice-manifest entry may carry; reject anything else (strict).
_ENTRY_KEYS = frozenset({"id", "behavior_class", "side"})

#: The keys the manifest document may carry at the top level.
_MANIFEST_KEYS = frozenset({"version", "seed", "slice"})


@dataclass(frozen=True, slots=True)
class CalibrationSliceEntry:
    """One frozen slice member: the parent's id, its behavior class (the κ stratum
    key), and its split side (always ``"dev"`` — the slice never touches holdout)."""

    item_id: str
    behavior_class: BehaviorClass
    side: Side


@dataclass(frozen=True, slots=True)
class CalibrationSlice:
    """The frozen calibration slice: its entries (ordered by ``SHA-256(item.id)``
    for a stable manifest) and the seed that produced it."""

    entries: tuple[CalibrationSliceEntry, ...]
    seed: int

    @property
    def item_ids(self) -> tuple[str, ...]:
        return tuple(entry.item_id for entry in self.entries)

    @property
    def size(self) -> int:
        return len(self.entries)


def _digest(item_id: str) -> str:
    """The stable per-item ordering key: ``SHA-256`` of the id (as in
    :func:`golden_split._ordering_key`). Decouples the slice from lexical id naming
    and from YAML authoring order while staying fully reproducible."""
    return hashlib.sha256(item_id.encode("utf-8")).hexdigest()


def _dev_parents_by_class(
    items: Sequence[GoldenItem],
    sides: Mapping[str, Side],
) -> dict[str, list[GoldenItem]]:
    """Group the eligible items — dev-side PARENTS only — by behavior class, each
    group ordered by ``SHA-256(item.id)`` so the seeded draw is input-order-free."""
    by_class: dict[str, list[GoldenItem]] = {}
    for item in items:
        if item.paraphrase_of is not None:  # parents only
            continue
        if sides.get(item.id) != "dev":  # the holdout seal beats every floor
            continue
        by_class.setdefault(item.behavior_class, []).append(item)
    for group in by_class.values():
        group.sort(key=lambda item: _digest(item.id))
    return by_class


def select_calibration_slice(
    items: Sequence[GoldenItem],
    *,
    sides: Mapping[str, Side],
    size: int = DEFAULT_CALIBRATION_SLICE_SIZE,
    seed: int,
    refusal_floor: int = DEFAULT_REFUSAL_FLOOR,
) -> CalibrationSlice:
    """Draw the stratified, seeded, dev-only, parents-only calibration slice.

    Each refusal class contributes ``min(refusal_floor, pool)`` items (the floor,
    or all there are when the pool is smaller); the remainder of ``size`` is drawn
    from the ``answer`` class. Within every stratum the pool is ordered by
    ``SHA-256(item.id)`` and sampled without replacement by a seeded RNG, so the
    same seed over the same pool always yields the same ids regardless of input
    order. Raises ``ValueError`` for a non-positive ``size`` or negative floor.
    """
    if size <= 0:
        raise ValueError("calibration-slice size must be a positive integer")
    if refusal_floor < 0:
        raise ValueError("refusal_floor must be non-negative")

    by_class = _dev_parents_by_class(items, sides)
    rng = random.Random(seed)

    selected: list[GoldenItem] = []
    selected_ids: set[str] = set()

    # Floor pass: guarantee each refusal class up to the floor, in canonical order.
    for refusal_class in REFUSAL_BEHAVIOR_CLASSES:
        pool = by_class.get(refusal_class, [])
        take = min(refusal_floor, len(pool), size - len(selected))
        if take <= 0:
            continue
        for item in rng.sample(pool, take):
            selected.append(item)
            selected_ids.add(item.id)

    # Remainder pass: fill the rest of the budget from the answer class.
    remaining = size - len(selected)
    if remaining > 0:
        answer_pool = [
            item
            for item in by_class.get(_REMAINDER_BEHAVIOR_CLASS, [])
            if item.id not in selected_ids
        ]
        for item in rng.sample(answer_pool, min(remaining, len(answer_pool))):
            selected.append(item)
            selected_ids.add(item.id)

    entries = tuple(
        sorted(
            (
                CalibrationSliceEntry(
                    item_id=item.id,
                    behavior_class=item.behavior_class,
                    side="dev",
                )
                for item in selected
            ),
            key=lambda entry: _digest(entry.item_id),
        )
    )
    return CalibrationSlice(entries=entries, seed=seed)


def render_slice_manifest(slice_: CalibrationSlice) -> str:
    """Render the frozen slice manifest as YAML (entries already SHA-256-ordered).

    Mirrors ``golden_split``'s committed ``split-manifest.yaml``: a small, legible,
    diff-stable artifact that freezes exactly which parents the slice grades."""
    import yaml  # noqa: PLC0415

    document = {
        "version": 1,
        "seed": slice_.seed,
        "slice": [
            {
                "id": entry.item_id,
                "behavior_class": entry.behavior_class,
                "side": entry.side,
            }
            for entry in slice_.entries
        ],
    }
    header = (
        "# Frozen judge-calibration slice (issue #19, ADR 0010 Decision 2).\n"
        "#\n"
        "# The ~20 dev PARENTS whose answer points a human grades for the\n"
        "# judge–human κ. Stratified by behavior class (floor ≥3 per refusal\n"
        "# class, remainder from `answer`), ordered by SHA-256(id), seeded.\n"
        "# Regenerate ONLY at a deliberate milestone (a reshuffle re-opens #19).\n"
    )
    return header + yaml.safe_dump(document, sort_keys=False, allow_unicode=True)


def parse_slice_manifest(text: str) -> CalibrationSlice:
    """Parse a committed slice manifest, strictly (the golden_item.py philosophy).

    Rejects unknown top-level or per-entry keys, a missing/typo'd behavior class,
    and — crucially — any side other than ``"dev"`` (a calibration item on the
    holdout would break the ADR 0007 seal). Never mutates its input.
    """
    import yaml  # noqa: PLC0415

    raw = yaml.safe_load(text)
    if not isinstance(raw, dict):
        raise ValueError("slice manifest must be a mapping")
    _reject_unknown_keys(raw, _MANIFEST_KEYS, "slice manifest")

    seed = raw.get("seed")
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise ValueError("slice manifest requires an integer seed")

    raw_slice = raw.get("slice")
    if not isinstance(raw_slice, list) or not raw_slice:
        raise ValueError("slice manifest requires a non-empty slice list")

    entries = tuple(_parse_entry(entry) for entry in raw_slice)
    return CalibrationSlice(entries=entries, seed=seed)


def _parse_entry(entry: object) -> CalibrationSliceEntry:
    if not isinstance(entry, dict):
        raise ValueError("slice manifest entry must be a mapping")
    _reject_unknown_keys(entry, _ENTRY_KEYS, "slice manifest entry")

    item_id = entry.get("id")
    if not isinstance(item_id, str) or not item_id:
        raise ValueError("slice manifest entry requires a non-empty id")

    behavior_class = entry.get("behavior_class")
    if behavior_class not in BEHAVIOR_CLASSES:
        raise ValueError(
            f"slice manifest entry {item_id!r} has unknown behavior_class "
            f"{behavior_class!r}; expected one of {sorted(BEHAVIOR_CLASSES)}"
        )

    side = entry.get("side")
    if side != "dev":
        raise ValueError(
            f"slice manifest entry {item_id!r} has side {side!r}; the calibration "
            "slice is dev-only (the holdout stays sealed, ADR 0007)"
        )

    return CalibrationSliceEntry(
        item_id=item_id,
        behavior_class=behavior_class,  # type: ignore[arg-type]
        side="dev",
    )


def _reject_unknown_keys(value: dict, allowed: frozenset[str], what: str) -> None:
    unknown = set(value) - allowed
    if unknown:
        raise ValueError(f"{what} has unknown keys: {sorted(unknown)}")


__all__ = [
    "REFUSAL_BEHAVIOR_CLASSES",
    "DEFAULT_CALIBRATION_SLICE_SIZE",
    "DEFAULT_REFUSAL_FLOOR",
    "SLICE_MANIFEST_FILENAME",
    "CalibrationSliceEntry",
    "CalibrationSlice",
    "select_calibration_slice",
    "render_slice_manifest",
    "parse_slice_manifest",
]
