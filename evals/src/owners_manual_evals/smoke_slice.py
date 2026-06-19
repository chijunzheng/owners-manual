"""The fixed, versioned smoke-v2 slice composition (issues #11, #22).

CONTEXT.md ("Smoke slice"): the fixed ~12-item subset run on every merge — all
five behavior classes, every available corpus, ≥1 cross-corpus item, drawn from
stable-at-baseline items so a failure is signal, not flake. Scored with
deterministic metrics only (the structured answer envelope makes behavior and
cites machine-checkable without a judge). The composition is versioned
(``smoke-v1``, ``smoke-v2``) and changes only at milestones, so trend lines
compare like with like.

The composition is an explicit, committed id allowlist (:data:`SMOKE_V2_ITEM_IDS`)
resolved against the loaded golden set. It is a PURE function: the same golden
set always yields the same slice, and any drift — a curated id that vanished, an
item that moved to holdout, a missing behavior class, an unverified item — is a
loud :class:`ValueError`, never a silent skip. Changing the slice is therefore a
deliberate edit to this list at a milestone, exactly as CONTEXT.md requires.

Two system invariants constrain WHICH golden items the slice may draw, and both
are enforced here rather than left to a caller:

* **Dev-only.** The smoke gate runs per merge, which is the iteration cadence, so
  it is iteration-facing and must see the DEV split only (CONTEXT.md, "Dev/holdout
  split": "Iteration and failure reading touch dev only; holdout runs at release
  tier"; :mod:`eval_tier` refuses to unseal the holdout below the release tier).
  A per-merge slice that drew a holdout item would leak the overfit detector.
* **Stable-at-baseline.** No measured baseline-stability signal exists yet — the
  per-metric thresholds are calibrated only at #24, from the jitter observed
  during this report-only phase. Until then the curated allowlist IS the
  stability record: golden-v0's answers over the designed fixtures are ground
  truth by construction (CONTEXT.md, "Designed fixture"), so a curated synthetic
  item is stable by construction, and the slice changing requires a code edit.

Coverage (smoke-v2, the #22 re-split): generalizing the dev/holdout split to
(corpus × behavior class) moved the ``flag-void-no-pets`` family — the
``cross-corpus`` slice (its cites span tenancy and the governing declaration) —
onto the DEV side. So smoke-v2 covers the tenancy AND cross-corpus slices (and
that cross-corpus item exercises governing-document retrieval), the coverage
smoke-v1 had to defer while the family sat on holdout (its "known coverage gap"),
exactly the "a re-split puts such an item on the dev side" milestone smoke-v1
anticipated. The standalone governing and insurance slices enter when the v1
governing/insurance authoring lands stable dev-side items — later composition
changes, by design.
"""

from __future__ import annotations

from dataclasses import dataclass

from .golden_item import BEHAVIOR_CLASSES, GoldenItem
from .golden_loader import GoldenSet
from .golden_split import assign_split

#: The versioned composition tag (CONTEXT.md): trend lines compare like with like.
SMOKE_SLICE_VERSION = "smoke-v2"

#: The committed smoke-v2 item ids, in run order. All ten are dev-side, verified
#: golden-v0 parents spanning all five behavior classes and the tenancy,
#: governing, and cross-corpus slices. Changing this list is a milestone
#: composition change (smoke-v3), never incidental. Grouped by behavior class:
#:
#: * answer (4): the core in-scope answers, including the enforceable-terms
#:   over-flagging control;
#: * flag-void-clause (2): the void-clause analyses — including ``flag-void-no-pets``,
#:   the ``cross-corpus`` item (its cites span tenancy and the governing
#:   declaration) the #22 re-split put on the dev side, so smoke-v2 covers the
#:   cross-corpus slice for the first time;
#: * refuse-advice-escalate (2), refuse-jurisdiction (1), refuse-out-of-scope (1):
#:   the refusal classes, each first-class.
#:
#: Paraphrase variants are deliberately excluded — paraphrase robustness is a
#: separate delta (CONTEXT.md), not part of the per-merge signal.
SMOKE_V2_ITEM_IDS: tuple[str, ...] = (
    # answer
    "answer-purchaser-own-use",
    "answer-rent-increase-rules",
    "answer-arrears-n4",
    "answer-enforceable-lease-terms",
    # flag-void-clause (flag-void-no-pets is the cross-corpus tenancy × governing item)
    "flag-void-no-pets",
    "flag-void-renewal-showings",
    # refuse-advice-escalate
    "refuse-advice-will-i-win",
    "refuse-advice-best-option",
    # refuse-jurisdiction
    "refuse-jurisdiction-commercial",
    # refuse-out-of-scope
    "refuse-scope-weather",
)


@dataclass(frozen=True, slots=True)
class SmokeSlice:
    """The resolved smoke slice: its version tag and the ordered golden items.

    ``items`` is in :data:`SMOKE_V2_ITEM_IDS` order — the run order — and has
    passed every composition invariant (present, verified, dev-side, all five
    behavior classes, every dev-available corpus).
    """

    version: str
    items: tuple[GoldenItem, ...]


def compose_smoke_slice(
    golden: GoldenSet,
    *,
    item_ids: tuple[str, ...] = SMOKE_V2_ITEM_IDS,
) -> SmokeSlice:
    """Resolve the curated ``item_ids`` against ``golden`` into a :class:`SmokeSlice`.

    Enforces every composition invariant, raising :class:`ValueError` on the first
    violation rather than skipping silently — a drifted slice is a loud failure:

    * every curated id exists in the golden set;
    * every resolved item is ``verified`` (an unverified item can never score);
    * every resolved item is on the DEV split (the smoke tier never unseals the
      holdout — that would leak the overfit detector);
    * all five behavior classes are represented;
    * the slice covers every corpus the dev side makes available.

    ``item_ids`` is injectable purely so the invariants can be tested against a
    deliberately-broken list; production always uses :data:`SMOKE_V2_ITEM_IDS`.
    """
    by_id = {item.id: item for item in golden.items}
    sides = assign_split(golden.items)

    missing = [item_id for item_id in item_ids if item_id not in by_id]
    if missing:
        raise ValueError(
            f"smoke-v2 slice names item id(s) absent from the golden set: {missing}. "
            "The composition is versioned and changes only at milestones — a vanished "
            "item is a drift to fix, not to skip."
        )

    items = tuple(by_id[item_id] for item_id in item_ids)

    unverified = [item.id for item in items if not item.verified]
    if unverified:
        raise ValueError(
            f"smoke-v2 slice names unverified item id(s): {unverified}. An unverified "
            "item can never enter a scored run (CONTEXT.md, Golden set)."
        )

    holdout = [item.id for item in items if sides.get(item.id) != "dev"]
    if holdout:
        raise ValueError(
            f"smoke-v2 slice names holdout-side item id(s): {holdout}. The per-merge "
            "smoke tier is iteration-facing and must run the dev split only; drawing a "
            "holdout item would leak the overfit detector (CONTEXT.md, Dev/holdout split)."
        )

    present_classes = {item.behavior_class for item in items}
    missing_classes = [cls for cls in BEHAVIOR_CLASSES if cls not in present_classes]
    if missing_classes:
        raise ValueError(
            f"smoke-v2 slice is missing behavior class(es): {missing_classes}. The slice "
            "must exercise all five behavior classes on every merge (CONTEXT.md)."
        )

    _require_every_dev_corpus(golden=golden, sides=sides, items=items)

    return SmokeSlice(version=SMOKE_SLICE_VERSION, items=items)


def _require_every_dev_corpus(
    *,
    golden: GoldenSet,
    sides: dict[str, str],
    items: tuple[GoldenItem, ...],
) -> None:
    """Assert the slice covers every corpus SLICE the dev side makes available.

    Coverage is measured by the authoritative ``item.corpus`` (the dashboard
    slice), not by the corpora an item's cites happen to touch — so a cite-less
    refusal or adversarial item still counts toward its corpus (Codex PR #60).
    "Available" is bounded by the holdout seal: a corpus present only on holdout
    is not available to a dev-only per-merge slice.
    """
    dev_corpora = {item.corpus for item in golden.items if sides.get(item.id) == "dev"}
    slice_corpora = {item.corpus for item in items}
    missing = sorted(dev_corpora - slice_corpora)
    if missing:
        raise ValueError(
            f"smoke-v2 slice does not cover dev-available corpus/corpora: {missing}. "
            "The slice must span every corpus the dev side makes available (CONTEXT.md)."
        )


def load_smoke_slice() -> SmokeSlice:
    """Load golden-v0 and compose the committed smoke-v2 slice from it.

    The convenience entry point the live runner and the workflow use; the heavy
    golden-v0 loader is imported lazily so importing this module stays cheap and
    needs no fixture trees on disk.
    """
    from .golden_v0 import load_golden_v0_set  # noqa: PLC0415

    return compose_smoke_slice(load_golden_v0_set())


__all__ = [
    "SMOKE_SLICE_VERSION",
    "SMOKE_V2_ITEM_IDS",
    "SmokeSlice",
    "compose_smoke_slice",
    "load_smoke_slice",
]
