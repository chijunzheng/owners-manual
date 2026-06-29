"""Stratified seeded calibration-slice sampler tests (issue #19, ADR 0010 Decision 2).

The calibration slice (CONTEXT.md, "Calibration slice") is ~20 golden items whose
answer points a human grades. ADR 0010 Decision 2 pins HOW it is drawn: from the
**dev** split only (the holdout stays sealed — rubric-wrong findings edit items),
**parents only** (no paraphrase variants), stratified by behavior class with a
**floor of ≥3 per refusal class**, the remainder from the ``answer`` class, ordered
by ``SHA-256(item.id)`` (the ADR 0007 reproducibility discipline), seeded and
sampled without replacement (extending ``variance_audit.select_variance_slice``'s
discipline to a stratified one).

These pin the sampler's mechanics — never LLM output quality:

* determinism (same seed + same pool ⇒ the same ids, independent of input order);
* the ≥3-per-refusal-class floor is honored when the pool allows, and degrades to
  "take all there are" when a refusal class has fewer than the floor;
* paraphrase variants are never selected (parents only);
* only dev items are selected (the holdout seal, ADR 0007).
"""

from __future__ import annotations

import pytest

from owners_manual_evals.calibration_slice import (
    REFUSAL_BEHAVIOR_CLASSES,
    CalibrationSlice,
    parse_slice_manifest,
    render_slice_manifest,
    select_calibration_slice,
)
from owners_manual_evals.golden_item import (
    AnswerPoint,
    GoldenItem,
    Provenance,
)
from owners_manual_evals.golden_split import Side


def _item(
    item_id: str,
    behavior_class: str,
    *,
    corpus: str = "tenancy",
    paraphrase_of: str | None = None,
) -> GoldenItem:
    """A minimal in-memory golden item (no live data) for the sampler suite."""
    return GoldenItem(
        id=item_id,
        behavior_class=behavior_class,  # type: ignore[arg-type]
        verified=True,
        question=f"q for {item_id}?",
        answer_points=(AnswerPoint(id="p", text="t"),),
        required_cites=(),
        provenance=Provenance(source="statute", reference="x"),
        corpus=corpus,  # type: ignore[arg-type]
        paraphrase_of=paraphrase_of,
    )


def _population() -> tuple[tuple[GoldenItem, ...], dict[str, Side]]:
    """A controlled dev/holdout pool: 5 parents in every refusal class, 12 answer
    parents, plus holdout items and paraphrase variants that must never be drawn."""
    items: list[GoldenItem] = []
    sides: dict[str, Side] = {}

    for cls in REFUSAL_BEHAVIOR_CLASSES:
        for n in range(5):
            item = _item(f"{cls}-dev-{n}", cls)
            items.append(item)
            sides[item.id] = "dev"
        # A holdout sibling per refusal class — never eligible.
        holdout = _item(f"{cls}-holdout", cls)
        items.append(holdout)
        sides[holdout.id] = "holdout"

    for n in range(12):
        item = _item(f"answer-dev-{n}", "answer")
        items.append(item)
        sides[item.id] = "dev"

    # A paraphrase variant of a dev refusal parent — parents only, so excluded.
    variant = _item(
        "refuse-jurisdiction-dev-0-para",
        "refuse-jurisdiction",
        paraphrase_of="refuse-jurisdiction-dev-0",
    )
    items.append(variant)
    sides[variant.id] = "dev"

    return tuple(items), sides


# --- determinism -----------------------------------------------------------


def test_same_seed_same_pool_yields_the_same_ids() -> None:
    items, sides = _population()
    a = select_calibration_slice(items, sides=sides, size=20, seed=19)
    b = select_calibration_slice(items, sides=sides, size=20, seed=19)
    assert a.item_ids == b.item_ids


def test_selection_is_independent_of_input_ordering() -> None:
    # SHA-256(id) ordering decouples the slice from YAML authoring order (ADR 0007):
    # the SAME seed over a reversed pool selects the SAME set.
    items, sides = _population()
    forward = select_calibration_slice(items, sides=sides, size=20, seed=19)
    reversed_pool = select_calibration_slice(tuple(reversed(items)), sides=sides, size=20, seed=19)
    assert set(forward.item_ids) == set(reversed_pool.item_ids)


def test_no_duplicate_ids_in_the_slice() -> None:
    items, sides = _population()
    chosen = select_calibration_slice(items, sides=sides, size=20, seed=3)
    assert len(set(chosen.item_ids)) == len(chosen.item_ids)


# --- the refusal-class floor ----------------------------------------------


def test_floor_of_three_per_refusal_class_is_honored_when_the_pool_allows() -> None:
    items, sides = _population()  # every refusal class has 5 dev parents
    chosen = select_calibration_slice(items, sides=sides, size=20, seed=19, refusal_floor=3)
    by_class = _count_by_class(chosen)
    for refusal_class in REFUSAL_BEHAVIOR_CLASSES:
        assert by_class.get(refusal_class, 0) >= 3, refusal_class


def test_floor_degrades_to_take_all_when_a_refusal_class_is_too_small() -> None:
    # refuse-jurisdiction has a SINGLE dev parent — the floor cannot be met, so the
    # sampler takes the one it has rather than erroring (ADR: "when the pool allows").
    items: list[GoldenItem] = [_item("refuse-jurisdiction-only", "refuse-jurisdiction")]
    sides: dict[str, Side] = {"refuse-jurisdiction-only": "dev"}
    for n in range(10):
        a = _item(f"answer-{n}", "answer")
        items.append(a)
        sides[a.id] = "dev"

    chosen = select_calibration_slice(tuple(items), sides=sides, size=8, seed=5, refusal_floor=3)
    by_class = _count_by_class(chosen)
    assert by_class.get("refuse-jurisdiction", 0) == 1  # took all there was, no crash


def test_remainder_is_drawn_from_the_answer_class() -> None:
    items, sides = _population()
    chosen = select_calibration_slice(items, sides=sides, size=20, seed=19, refusal_floor=3)
    by_class = _count_by_class(chosen)
    # 4 refusal classes x floor 3 = 12 refusal points; the rest (8) come from answer.
    assert by_class.get("answer", 0) == 20 - 12


# --- parents only, dev only ------------------------------------------------


def test_paraphrase_variants_are_never_selected() -> None:
    items, sides = _population()
    chosen = select_calibration_slice(items, sides=sides, size=20, seed=19)
    assert all(not item_id.endswith("-para") for item_id in chosen.item_ids)


def test_only_dev_items_are_selected() -> None:
    items, sides = _population()
    chosen = select_calibration_slice(items, sides=sides, size=20, seed=19)
    assert all(sides[item_id] == "dev" for item_id in chosen.item_ids)
    assert all(entry.side == "dev" for entry in chosen.entries)


def test_holdout_items_are_excluded_even_when_they_would_fill_the_floor() -> None:
    # Only a holdout refusal item exists for one class — it must NOT be drawn to
    # meet the floor; the seal beats the floor.
    items = (
        _item("refuse-out-of-scope-holdout", "refuse-out-of-scope"),
        *[_item(f"answer-{n}", "answer") for n in range(6)],
    )
    sides: dict[str, Side] = {"refuse-out-of-scope-holdout": "holdout"}
    for n in range(6):
        sides[f"answer-{n}"] = "dev"
    chosen = select_calibration_slice(items, sides=sides, size=6, seed=1)
    assert "refuse-out-of-scope-holdout" not in chosen.item_ids


# --- the frozen manifest ---------------------------------------------------


def test_slice_manifest_round_trips_through_yaml() -> None:
    items, sides = _population()
    chosen = select_calibration_slice(items, sides=sides, size=20, seed=19)
    reloaded = parse_slice_manifest(render_slice_manifest(chosen))
    assert reloaded.entries == chosen.entries
    assert reloaded.seed == chosen.seed


def test_manifest_entries_are_ordered_by_sha256_of_the_id() -> None:
    import hashlib

    items, sides = _population()
    chosen = select_calibration_slice(items, sides=sides, size=20, seed=19)
    digests = [hashlib.sha256(e.item_id.encode("utf-8")).hexdigest() for e in chosen.entries]
    assert digests == sorted(digests)


def test_parse_slice_manifest_rejects_a_holdout_side() -> None:
    # The slice is dev-only by construction; a manifest recording a holdout side is
    # a seal violation and must be rejected, not loaded.
    bad = (
        "version: 1\n"
        "seed: 19\n"
        "slice:\n"
        "  - id: answer-dev-0\n"
        "    behavior_class: answer\n"
        "    side: holdout\n"
    )
    with pytest.raises(ValueError, match="dev"):
        parse_slice_manifest(bad)


def test_parse_slice_manifest_rejects_unknown_entry_keys() -> None:
    # Strict-parser philosophy (golden_item.py): reject a smuggled key rather than
    # coerce — e.g. a judge verdict has no business in the slice manifest.
    bad = (
        "version: 1\n"
        "seed: 19\n"
        "slice:\n"
        "  - id: answer-dev-0\n"
        "    behavior_class: answer\n"
        "    side: dev\n"
        "    judge: credited\n"
    )
    with pytest.raises(ValueError, match="unknown"):
        parse_slice_manifest(bad)


# --- the committed fixture is consistent with the live golden set ----------


def test_committed_slice_manifest_is_dev_parents_only_of_the_real_set() -> None:
    # The frozen artifact (the #19 deliverable) must name only dev PARENTS that
    # actually exist in the golden set — never a holdout item, a paraphrase, or a
    # ghost id. This ties the committed bytes to the live split.
    from owners_manual_evals.golden_fixtures import resolve_fixtures_dir
    from owners_manual_evals.golden_split import assign_split
    from owners_manual_evals.golden_v0 import load_golden_v0_set

    manifest_path = resolve_fixtures_dir().parent / "calibration" / "slice-manifest.yaml"
    manifest = parse_slice_manifest(manifest_path.read_text(encoding="utf-8"))

    golden = load_golden_v0_set()
    sides = assign_split(golden.items)
    by_id = {item.id: item for item in golden.items}

    for entry in manifest.entries:
        assert entry.item_id in by_id, entry.item_id
        item = by_id[entry.item_id]
        assert item.paraphrase_of is None  # parents only
        assert sides[entry.item_id] == "dev"  # the holdout seal
        assert item.behavior_class == entry.behavior_class  # stratum key matches


def test_committed_slice_manifest_matches_the_sampler_for_its_seed() -> None:
    # Regenerating the slice from the live set at the recorded seed reproduces the
    # committed manifest exactly — so the fixture cannot drift from the algorithm.
    from owners_manual_evals.golden_fixtures import resolve_fixtures_dir
    from owners_manual_evals.golden_split import assign_split
    from owners_manual_evals.golden_v0 import load_golden_v0_set

    manifest_path = resolve_fixtures_dir().parent / "calibration" / "slice-manifest.yaml"
    manifest = parse_slice_manifest(manifest_path.read_text(encoding="utf-8"))

    golden = load_golden_v0_set()
    sides = assign_split(golden.items)
    regenerated = select_calibration_slice(golden.items, sides=sides, size=20, seed=manifest.seed)
    assert regenerated.entries == manifest.entries


def _count_by_class(chosen: CalibrationSlice) -> dict[str, int]:
    counts: dict[str, int] = {}
    for entry in chosen.entries:
        counts[entry.behavior_class] = counts.get(entry.behavior_class, 0) + 1
    return counts
