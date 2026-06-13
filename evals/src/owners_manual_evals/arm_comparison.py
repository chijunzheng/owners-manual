"""The hybrid-vs-vector-only hit-rate comparison (#14 AC4).

The dashboard surface that answers "did hybrid retrieval earn its complexity on
retrieval?" — by reporting the pre-synthesis required-cite hit-rate for the
vector-only and hybrid arms SIDE BY SIDE, per behavior-class slice and overall,
with the delta. It obeys the same two CONTEXT.md rules the score dashboard does:

* metrics are **never collapsed into one blended scalar** — each arm stands in
  its own column and the delta is reported, not a single fused number;
* **slices are never averaged together** — the ``all`` row is over items.

The comparison is paired by item id (the SAME golden items run through both
arms), so the delta attributes a hit-rate change to the retrieval mechanism, not
to a different item mix. The sign is reported honestly: hybrid is not assumed to
win. Refusal items carry no required cites, so their hit-rate is 1.0 in both arms
(:mod:`metrics`) and they never move the delta.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .metrics import ItemScore


@dataclass(frozen=True, slots=True)
class HitRateComparisonRow:
    """One comparison row: a slice, both arms' mean hit-rate, and the delta."""

    slice: str
    count: int
    vector_only_hit_rate: float
    hybrid_hit_rate: float
    #: hybrid minus vector-only — positive means hybrid reached more cites.
    delta: float


@dataclass(frozen=True, slots=True)
class HitRateComparison:
    """The full comparison: per-behavior-class slices plus the ``all`` row."""

    slices: tuple[HitRateComparisonRow, ...]
    overall: HitRateComparisonRow


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _row(
    slice_name: str,
    vector: Sequence[ItemScore],
    hybrid: Sequence[ItemScore],
) -> HitRateComparisonRow:
    vector_rate = _mean([s.retrieval_hit_rate for s in vector])
    hybrid_rate = _mean([s.retrieval_hit_rate for s in hybrid])
    return HitRateComparisonRow(
        slice=slice_name,
        count=len(vector),
        vector_only_hit_rate=vector_rate,
        hybrid_hit_rate=hybrid_rate,
        delta=hybrid_rate - vector_rate,
    )


def build_hit_rate_comparison(
    *,
    vector_only: Sequence[ItemScore],
    hybrid: Sequence[ItemScore],
) -> HitRateComparison:
    """Build the paired-by-item hit-rate comparison of the two arms.

    Raises ``ValueError`` if the two arms do not cover the same set of item ids —
    a paired comparison over a mismatched item set would be meaningless.
    """
    vector_by_id = {s.item_id: s for s in vector_only}
    hybrid_by_id = {s.item_id: s for s in hybrid}
    if vector_by_id.keys() != hybrid_by_id.keys():
        raise ValueError("vector_only and hybrid must cover the same item ids (paired comparison)")

    # Group by behavior class, first-seen order on the vector arm.
    order: list[str] = []
    groups: dict[str, list[str]] = {}
    for score in vector_only:
        groups.setdefault(score.behavior_class, []).append(score.item_id)
        if score.behavior_class not in order:
            order.append(score.behavior_class)

    slices = tuple(
        _row(
            name,
            [vector_by_id[item_id] for item_id in groups[name]],
            [hybrid_by_id[item_id] for item_id in groups[name]],
        )
        for name in order
    )
    overall = _row(
        "all",
        [vector_by_id[item_id] for item_id in vector_by_id],
        [hybrid_by_id[item_id] for item_id in vector_by_id],
    )
    return HitRateComparison(slices=slices, overall=overall)


def render_hit_rate_comparison(comparison: HitRateComparison, *, run_name: str) -> str:
    """Render the comparison as an aligned table with an honest headline delta."""
    header = f"{'slice':<24}{'n':>4}  {'vector':>8}  {'hybrid':>8}  {'Δ (delta)':>10}"

    def row(r: HitRateComparisonRow) -> str:
        sign = "+" if r.delta >= 0 else "-"
        return (
            f"{r.slice:<24}{r.count:>4}  {r.vector_only_hit_rate:>8.2%}  "
            f"{r.hybrid_hit_rate:>8.2%}  {sign}{abs(r.delta):>8.2%}"
        )

    overall = comparison.overall
    sign = "+" if overall.delta >= 0 else "-"
    if overall.delta > 0:
        verdict = "hybrid ahead"
    elif overall.delta < 0:
        verdict = "vector-only ahead"
    else:
        verdict = "tied"
    lines = [
        f"=== {run_name} — required-cite hit rate: hybrid vs vector-only ===",
        f"HEADLINE hit-rate delta (all): {sign}{abs(overall.delta):.2%} "
        f"({verdict}) over {overall.count} item(s)",
        "",
        header,
        "-" * len(header),
        *(row(r) for r in comparison.slices),
        "-" * len(header),
        row(overall),
        "",
        "Pre-synthesis required-cite hit rate, hierarchically matched. Each arm "
        "stands in its own column; slices are never averaged together. The sign "
        "is reported as measured — hybrid is not assumed to win.",
    ]
    return "\n".join(lines)


__all__ = [
    "HitRateComparisonRow",
    "HitRateComparison",
    "build_hit_rate_comparison",
    "render_hit_rate_comparison",
]
