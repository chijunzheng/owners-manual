"""The fixed, versioned smoke-v1 slice composition (issue #11).

CONTEXT.md ("Smoke slice"): the fixed ~12-item subset run on every merge — all
five behavior classes, every available corpus, drawn from stable-at-baseline
items so a failure is signal, not flake. Scored with deterministic metrics only.
Composition is versioned (smoke-v1) and changes only at milestones.

Two invariants from the wider system constrain WHICH items the slice may draw:

* The smoke gate runs per merge — that is the iteration cadence, so it is
  iteration-facing and must see the DEV split only. CONTEXT.md ("Dev/holdout
  split"): "Iteration and failure reading touch dev only; holdout runs at release
  tier", and :mod:`eval_tier` refuses to unseal the holdout below the release
  tier. A per-merge slice drawing a holdout item would leak the overfit detector.
* "Stable-at-baseline" — the slice is built from a committed, curated id
  allowlist (``SMOKE_V1_ITEM_IDS``); because golden-v0's answers over the
  designed fixtures are ground truth by construction, the curated set is the
  stability record until a measured baseline-stability signal exists (post-#24
  threshold calibration). The composition refuses to drift: changing it is a
  deliberate code edit at a milestone, never an accident of the loader.

These tests pin the composition as a PURE function of the loaded golden set: the
exact id list, dev-only, verified-only, all five behavior classes, every corpus
the dev side makes available, and a loud failure if any invariant breaks.
"""

from __future__ import annotations

import pytest

from owners_manual_evals.golden_item import BEHAVIOR_CLASSES, parse_golden_item
from owners_manual_evals.golden_loader import GoldenSet
from owners_manual_evals.golden_split import assign_split
from owners_manual_evals.golden_v0 import load_golden_v0_set
from owners_manual_evals.oracle import corpus_of_document_id
from owners_manual_evals.smoke_slice import (
    SMOKE_SLICE_VERSION,
    SMOKE_V1_ITEM_IDS,
    SmokeSlice,
    compose_smoke_slice,
    load_smoke_slice,
)


def test_smoke_slice_version_is_smoke_v1() -> None:
    assert SMOKE_SLICE_VERSION == "smoke-v1"


def test_smoke_v1_is_twelve_items() -> None:
    # CONTEXT.md fixes the slice at ~12 items; smoke-v1 is exactly 12.
    assert len(SMOKE_V1_ITEM_IDS) == 12
    # The committed list has no duplicates.
    assert len(set(SMOKE_V1_ITEM_IDS)) == 12


def test_compose_returns_items_in_committed_order() -> None:
    slice_ = load_smoke_slice()
    assert isinstance(slice_, SmokeSlice)
    assert slice_.version == "smoke-v1"
    assert tuple(item.id for item in slice_.items) == SMOKE_V1_ITEM_IDS


def test_every_behavior_class_is_represented() -> None:
    slice_ = load_smoke_slice()
    present = {item.behavior_class for item in slice_.items}
    # All five behavior classes appear (CONTEXT.md).
    assert present == set(BEHAVIOR_CLASSES)


def test_slice_is_dev_only_never_unseals_holdout() -> None:
    golden = load_golden_v0_set()
    sides = assign_split(golden.items)
    slice_ = compose_smoke_slice(golden)
    # Every slice item is on the dev side — the per-merge smoke tier must never
    # run a holdout item (that would leak the overfit detector).
    assert all(sides[item.id] == "dev" for item in slice_.items)


def test_slice_is_verified_only() -> None:
    slice_ = load_smoke_slice()
    assert all(item.verified for item in slice_.items)


def test_slice_covers_every_corpus_available_on_the_dev_side() -> None:
    golden = load_golden_v0_set()
    sides = assign_split(golden.items)
    # The corpora reachable from dev-side items' required cites.
    dev_corpora = {
        corpus_of_document_id(cite.document_id)
        for item in golden.items
        if sides[item.id] == "dev"
        for cite in item.required_cites
    }
    slice_ = compose_smoke_slice(golden)
    slice_corpora = {
        corpus_of_document_id(cite.document_id)
        for item in slice_.items
        for cite in item.required_cites
    }
    # The slice covers every corpus the dev side makes available (tenancy today;
    # governing only enters via the holdout-sealed cross-corpus family, so it is
    # not yet representable in a dev-only per-merge slice — documented deferral).
    assert slice_corpora == dev_corpora
    assert "tenancy" in slice_corpora


def test_compose_rejects_an_unknown_item_id() -> None:
    # A curated id that is not in the golden set is a composition bug, not a
    # silent skip — the slice must fail loudly so it can never drift.
    golden = load_golden_v0_set()
    with pytest.raises(ValueError, match="absent from the golden set"):
        compose_smoke_slice(golden, item_ids=(*SMOKE_V1_ITEM_IDS, "no-such-item"))


def test_compose_rejects_a_holdout_item_in_the_allowlist() -> None:
    # If a golden-set re-split moved a curated item to holdout, the smoke tier
    # would be unsealing the holdout — refuse rather than leak it.
    golden = load_golden_v0_set()
    sides = assign_split(golden.items)
    holdout_ids = [i.id for i in golden.items if sides[i.id] == "holdout"]
    assert holdout_ids, "fixture sanity: golden-v0 has a holdout side"
    with pytest.raises(ValueError, match="holdout|dev"):
        compose_smoke_slice(golden, item_ids=(*SMOKE_V1_ITEM_IDS[:-1], holdout_ids[0]))


def test_compose_rejects_a_missing_behavior_class() -> None:
    # Dropping a class from the allowlist must fail — the slice's whole point is
    # to exercise all five behavior classes on every merge.
    golden = load_golden_v0_set()
    # Drop every refuse-out-of-scope id from the curated list.
    by_id = {i.id: i for i in golden.items}
    kept = tuple(
        item_id
        for item_id in SMOKE_V1_ITEM_IDS
        if by_id[item_id].behavior_class != "refuse-out-of-scope"
    )
    assert len(kept) < len(SMOKE_V1_ITEM_IDS)
    with pytest.raises(ValueError, match="behavior class"):
        compose_smoke_slice(golden, item_ids=kept)


def test_compose_rejects_an_unverified_item() -> None:
    # An unverified item can never enter a scored run (CONTEXT.md). Build a set
    # where a curated id is unverified and assert the composition refuses it.
    golden = load_golden_v0_set()
    target = SMOKE_V1_ITEM_IDS[0]

    def _unverify(item_id: str) -> object:
        original = next(i for i in golden.items if i.id == item_id)
        return parse_golden_item(
            {
                "id": original.id,
                "behavior_class": original.behavior_class,
                "verified": False,
                "question": original.question,
                "answer_points": [{"id": p.id, "text": p.text} for p in original.answer_points],
                "required_cites": [],
                "provenance": {
                    "source": original.provenance.source,
                    "reference": original.provenance.reference,
                },
            },
            documents=(),
        )

    mutated = GoldenSet(
        version=golden.version,
        items=tuple(_unverify(i.id) if i.id == target else i for i in golden.items),
    )
    with pytest.raises(ValueError, match="verified"):
        compose_smoke_slice(mutated)
