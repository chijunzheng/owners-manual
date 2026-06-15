"""The paired agent-vs-naive-rag score dashboard (issue #15 AC4).

The dashboard surface that answers "did the agent graph earn its complexity?" —
by reporting the SAME headline metrics the single-arm :mod:`dashboard` does
(strict pass rate, behavior match, citation precision/recall) for the naive-rag
and agent arms SIDE BY SIDE, per behavior-class slice and overall, with the
strict-pass delta. It obeys the same two CONTEXT.md rules:

* metrics are **never collapsed into one blended scalar** — each arm stands in
  its own columns and the delta is reported, not a single fused number;
* **slices are never averaged together** — the ``all`` row is over items.

The comparison is paired by item id (the SAME golden items run through both
arms), so the strict-pass delta attributes a change to the agent architecture,
not to a different item mix (CONTEXT.md: "paired arms attribute *where* lift comes
from"). The sign is reported honestly: the agent is not assumed to win. The
naive-rag arm is consumed exactly as it is (its scores come from the frozen
``/answer`` path) — this module never reshapes it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .metrics import ItemScore


@dataclass(frozen=True, slots=True)
class ArmDashboardRow:
    """One comparison row: a slice, both arms' headline metrics, and the delta."""

    slice: str
    count: int
    naive_strict_pass_rate: float
    agent_strict_pass_rate: float
    naive_behavior_match: float
    agent_behavior_match: float
    naive_cite_precision: float
    agent_cite_precision: float
    naive_cite_recall: float
    agent_cite_recall: float
    #: agent minus naive-rag strict pass rate — positive means the agent passed more.
    strict_pass_delta: float


@dataclass(frozen=True, slots=True)
class ArmDashboard:
    """The full comparison: per-behavior-class slices plus the ``all`` row."""

    slices: tuple[ArmDashboardRow, ...]
    overall: ArmDashboardRow


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _strict(scores: Sequence[ItemScore]) -> float:
    return _mean([1.0 if s.strict_pass else 0.0 for s in scores])


def _behavior(scores: Sequence[ItemScore]) -> float:
    return _mean([1.0 if s.behavior_match else 0.0 for s in scores])


def _row(
    slice_name: str,
    naive: Sequence[ItemScore],
    agent: Sequence[ItemScore],
) -> ArmDashboardRow:
    naive_strict = _strict(naive)
    agent_strict = _strict(agent)
    return ArmDashboardRow(
        slice=slice_name,
        count=len(naive),
        naive_strict_pass_rate=naive_strict,
        agent_strict_pass_rate=agent_strict,
        naive_behavior_match=_behavior(naive),
        agent_behavior_match=_behavior(agent),
        naive_cite_precision=_mean([s.cite_precision for s in naive]),
        agent_cite_precision=_mean([s.cite_precision for s in agent]),
        naive_cite_recall=_mean([s.cite_recall for s in naive]),
        agent_cite_recall=_mean([s.cite_recall for s in agent]),
        strict_pass_delta=agent_strict - naive_strict,
    )


def build_arm_dashboard(
    *,
    naive_rag: Sequence[ItemScore],
    agent: Sequence[ItemScore],
) -> ArmDashboard:
    """Build the paired-by-item agent-vs-naive-rag score comparison.

    Raises ``ValueError`` if the two arms do not cover the same set of item ids —
    a paired comparison over a mismatched item set would be meaningless.
    """
    naive_by_id = {s.item_id: s for s in naive_rag}
    agent_by_id = {s.item_id: s for s in agent}
    if naive_by_id.keys() != agent_by_id.keys():
        raise ValueError("naive_rag and agent must cover the same item ids (paired comparison)")

    # Group by behavior class, first-seen order on the naive-rag arm.
    order: list[str] = []
    groups: dict[str, list[str]] = {}
    for score in naive_rag:
        groups.setdefault(score.behavior_class, []).append(score.item_id)
        if score.behavior_class not in order:
            order.append(score.behavior_class)

    slices = tuple(
        _row(
            name,
            [naive_by_id[item_id] for item_id in groups[name]],
            [agent_by_id[item_id] for item_id in groups[name]],
        )
        for name in order
    )
    overall = _row(
        "all",
        [naive_by_id[item_id] for item_id in naive_by_id],
        [agent_by_id[item_id] for item_id in naive_by_id],
    )
    return ArmDashboard(slices=slices, overall=overall)


def render_arm_dashboard(dashboard: ArmDashboard, *, run_name: str) -> str:
    """Render the comparison as an aligned table with an honest strict-pass delta."""
    header = (
        f"{'slice':<24}{'n':>4}  "
        f"{'naive✓':>7}  {'agent✓':>7}  {'Δ✓':>8}  "
        f"{'n-behav':>8}  {'a-behav':>8}  "
        f"{'n-cR':>6}  {'a-cR':>6}"
    )

    def row(r: ArmDashboardRow) -> str:
        sign = "+" if r.strict_pass_delta >= 0 else "-"
        return (
            f"{r.slice:<24}{r.count:>4}  "
            f"{r.naive_strict_pass_rate:>7.2%}  {r.agent_strict_pass_rate:>7.2%}  "
            f"{sign}{abs(r.strict_pass_delta):>6.2%}  "
            f"{r.naive_behavior_match:>8.0%}  {r.agent_behavior_match:>8.0%}  "
            f"{r.naive_cite_recall:>6.0%}  {r.agent_cite_recall:>6.0%}"
        )

    overall = dashboard.overall
    sign = "+" if overall.strict_pass_delta >= 0 else "-"
    if overall.strict_pass_delta > 0:
        verdict = "agent ahead"
    elif overall.strict_pass_delta < 0:
        verdict = "naive-rag ahead"
    else:
        verdict = "tied"
    lines = [
        f"=== {run_name} — strict pass rate: agent vs naive-rag (paired by item) ===",
        f"HEADLINE strict-pass delta (all): {sign}{abs(overall.strict_pass_delta):.2%} "
        f"({verdict}) over {overall.count} item(s)",
        "",
        header,
        "-" * len(header),
        *(row(r) for r in dashboard.slices),
        "-" * len(header),
        row(overall),
        "",
        "Paired by item id (same golden items, both arms). Each arm stands in its "
        "own columns; slices are never averaged together; there is no single "
        "overall number. The sign is reported as measured — the agent is not "
        "assumed to win. (✓ = strict pass, cR = citation recall.)",
    ]
    return "\n".join(lines)


__all__ = [
    "ArmDashboardRow",
    "ArmDashboard",
    "build_arm_dashboard",
    "render_arm_dashboard",
]
