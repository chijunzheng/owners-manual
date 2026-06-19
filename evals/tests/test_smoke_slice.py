"""The fixed, versioned smoke-v2 slice composition (issues #11, #22).

CONTEXT.md ("Smoke slice"): the fixed ~12-item subset run on every merge — all
five behavior classes, every available corpus, ≥1 cross-corpus item, drawn from
stable-at-baseline items so a failure is signal, not flake. Scored with
deterministic metrics only. Composition is versioned (smoke-v2) and changes only
at milestones.

Three invariants from the wider system constrain WHICH items the slice may draw:
dev-only (the per-merge tier never unseals the holdout), verified-only (an
unverified item can never score), and live-serviceable (the gate runs against
the deployed service, so every item's cites must be in the live index).

These tests pin the composition as a PURE function of the loaded golden set: the
exact id list, dev-only, verified-only, live-serviceable, all five behavior
classes, every eligible corpus, and a loud failure if any invariant breaks.
"""

from __future__ import annotations

import pytest

from owners_manual_evals.citable_path import parse_citable_path
from owners_manual_evals.golden_item import (
    BEHAVIOR_CLASSES,
    AnswerPoint,
    GoldenItem,
    Provenance,
    parse_golden_item,
)
from owners_manual_evals.golden_loader import GoldenSet
from owners_manual_evals.golden_split import assign_split
from owners_manual_evals.golden_v0 import load_golden_v0_set
from owners_manual_evals.live_corpus import is_live_serviceable
from owners_manual_evals.smoke_slice import (
    SMOKE_SLICE_VERSION,
    SMOKE_V2_ITEM_IDS,
    SmokeSlice,
    _require_every_dev_corpus,
    compose_smoke_slice,
    load_smoke_slice,
)


def test_smoke_slice_version_is_smoke_v2() -> None:
    assert SMOKE_SLICE_VERSION == "smoke-v2"


def test_smoke_v2_is_ten_items() -> None:
    # CONTEXT.md fixes the slice at ~12 items; smoke-v2 is the 10 dev-side parents.
    assert len(SMOKE_V2_ITEM_IDS) == 10
    # The committed list has no duplicates.
    assert len(set(SMOKE_V2_ITEM_IDS)) == 10


def test_compose_returns_items_in_committed_order() -> None:
    slice_ = load_smoke_slice()
    assert isinstance(slice_, SmokeSlice)
    assert slice_.version == "smoke-v2"
    assert tuple(item.id for item in slice_.items) == SMOKE_V2_ITEM_IDS


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


def test_slice_is_live_serviceable() -> None:
    # The gate runs against the deployed service, so every slice item's cites must
    # be in the live index (live_corpus). This is the guard that keeps an
    # offline-only corpus out of the live gate.
    slice_ = load_smoke_slice()
    assert all(is_live_serviceable(item) for item in slice_.items)


def test_slice_covers_every_verified_live_serviceable_corpus_on_dev() -> None:
    golden = load_golden_v0_set()
    sides = assign_split(golden.items)
    # Coverage is measured over the verified, dev-side, LIVE-SERVICEABLE items —
    # the population the gate can actually run. The #22 insurance slice is verified
    # and dev-side but cites policies the live index does not hold, so it is
    # excluded until the corpus expands (then a milestone smoke-v3 adds it).
    eligible = {
        item.corpus
        for item in golden.items
        if sides[item.id] == "dev" and item.verified and is_live_serviceable(item)
    }
    slice_ = compose_smoke_slice(golden)
    slice_corpora = {item.corpus for item in slice_.items}
    assert slice_corpora == eligible
    assert {"tenancy", "cross-corpus"} <= slice_corpora
    # insurance IS verified + dev, but NOT live-serviceable -> gated out of smoke.
    insurance_dev_verified = any(
        item.corpus == "insurance" and item.verified and sides[item.id] == "dev"
        for item in golden.items
    )
    assert insurance_dev_verified  # the INS-03 slice is verified-dev...
    assert "insurance" not in slice_corpora  # ...yet correctly absent from the gate


def test_compose_rejects_a_non_live_serviceable_item() -> None:
    # Adding an item the live index cannot serve (the insurance INS-03 gap item,
    # whose cites are the policy fixtures) must fail loudly — this is the guard
    # that catches the premature smoke-v3 bump.
    golden = load_golden_v0_set()
    with pytest.raises(ValueError, match="live index cannot serve"):
        compose_smoke_slice(golden, item_ids=(*SMOKE_V2_ITEM_IDS, "answer-sewer-backup-gap"))


def test_coverage_filters_unverified_and_non_serviceable_dev_corpora() -> None:
    # The coverage helper counts only verified, live-serviceable dev corpora —
    # constructed so it is robust regardless of the live set's current state.
    def _item(item_id: str, corpus: str, *, verified: bool, doc_id: str) -> GoldenItem:
        return GoldenItem(
            id=item_id,
            behavior_class="answer",
            verified=verified,
            question="q",
            answer_points=(AnswerPoint(id="p", text="t"),),
            required_cites=(
                parse_citable_path(
                    {"documentId": doc_id, "segments": [{"kind": "section", "label": "1"}]}
                ),
            ),
            provenance=Provenance(source="s", reference="r"),
            corpus=corpus,
        )

    live = _item("a", "tenancy", verified=True, doc_id="rta-2006")
    unverified = _item("b", "governing", verified=False, doc_id="rta-2006")
    offline = _item("c", "selling", verified=True, doc_id="fixture-master-policy")
    golden = GoldenSet(version=2, items=(live, unverified, offline))
    sides = {"a": "dev", "b": "dev", "c": "dev"}
    # A slice covering only tenancy passes: governing (unverified) and selling
    # (verified but not live-serviceable) do not force coverage.
    _require_every_dev_corpus(golden=golden, sides=sides, items=(live,))

    # But a verified, live-serviceable governing item WOULD force coverage.
    forcing = _item("d", "governing", verified=True, doc_id="fixture-declaration")
    golden2 = GoldenSet(version=2, items=(live, forcing))
    with pytest.raises(ValueError, match="governing"):
        _require_every_dev_corpus(golden=golden2, sides={"a": "dev", "d": "dev"}, items=(live,))


def test_compose_rejects_an_unknown_item_id() -> None:
    # A curated id that is not in the golden set is a composition bug, not a
    # silent skip — the slice must fail loudly so it can never drift.
    golden = load_golden_v0_set()
    with pytest.raises(ValueError, match="absent from the golden set"):
        compose_smoke_slice(golden, item_ids=(*SMOKE_V2_ITEM_IDS, "no-such-item"))


def test_compose_rejects_a_holdout_item_in_the_allowlist() -> None:
    # If a golden-set re-split moved a curated item to holdout, the smoke tier
    # would be unsealing the holdout — refuse rather than leak it. Use a VERIFIED,
    # live-serviceable holdout item so the holdout guard is what fires.
    golden = load_golden_v0_set()
    sides = assign_split(golden.items)
    holdout_ids = [
        i.id
        for i in golden.items
        if sides[i.id] == "holdout" and i.verified and is_live_serviceable(i)
    ]
    assert holdout_ids, "fixture sanity: golden-v0 has a verified, serviceable holdout side"
    with pytest.raises(ValueError, match="holdout|dev"):
        compose_smoke_slice(golden, item_ids=(*SMOKE_V2_ITEM_IDS[:-1], holdout_ids[0]))


def test_compose_rejects_a_missing_behavior_class() -> None:
    # Dropping a class from the allowlist must fail — the slice's whole point is
    # to exercise all five behavior classes on every merge.
    golden = load_golden_v0_set()
    by_id = {i.id: i for i in golden.items}
    kept = tuple(
        item_id
        for item_id in SMOKE_V2_ITEM_IDS
        if by_id[item_id].behavior_class != "refuse-out-of-scope"
    )
    assert len(kept) < len(SMOKE_V2_ITEM_IDS)
    with pytest.raises(ValueError, match="behavior class"):
        compose_smoke_slice(golden, item_ids=kept)


def test_compose_rejects_an_unverified_item() -> None:
    # An unverified item can never enter a scored run (CONTEXT.md). Build a set
    # where a curated id is unverified and assert the composition refuses it.
    golden = load_golden_v0_set()
    target = SMOKE_V2_ITEM_IDS[0]

    def _unverify(item_id: str) -> object:
        original = next(i for i in golden.items if i.id == item_id)
        return parse_golden_item(
            {
                "id": original.id,
                "behavior_class": original.behavior_class,
                "corpus": "tenancy",
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
