"""The four-arm score dashboard (issue #18).

The paired :mod:`arm_dashboard` grows from two arms to FOUR: stuff, stuff-oracle,
naive-rag, agent — all on the SAME product model (ADR 0005), paired BY ITEM. It
obeys the same two CONTEXT.md rules as every dashboard: metrics are never
collapsed into one blended scalar (each arm stands in its own columns), and slices
are never averaged together (the ``all`` row is over items, and each behavior
class is its own slice).

Two #18 specifics:

* the LLM judge's ``point_score`` sits BESIDE the deterministic strict pass per
  arm (the judge runs beside the deterministic metrics, never replacing them);
* RAGAS context metrics appear for the RAG arms ONLY (naive-rag, agent); the
  stuffing arms carry ``None`` and the rendered table SAYS the column is RAG-only
  — a stuffing arm is never blended into a context metric.

The arms are consumed exactly as their runners produce them; the frozen naive-rag
and agent arms are extended into the four-arm table WITHOUT being reshaped.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from .metrics import ItemScore
from .ragas_metrics import ContextMetrics, is_rag_arm

#: The canonical four-arm order, simplest architecture first.
ARM_ORDER: tuple[str, ...] = ("stuff", "stuff-oracle", "naive-rag", "agent")


@dataclass(frozen=True, slots=True)
class ArmColumn:
    """One arm's inputs to the four-arm table, paired by item id.

    ``scores`` are the deterministic per-item scores; ``point_scores`` are the
    judge's per-item point scores (optional — absent when the judge has not run);
    ``context_metrics`` are RAGAS context metrics per item (RAG arms only).
    """

    scores: tuple[ItemScore, ...]
    point_scores: Mapping[str, float] = field(default_factory=dict)
    context_metrics: Mapping[str, ContextMetrics] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ArmCell:
    """One arm's metrics for one slice: strict pass, point score, recalls.

    ``context_recall`` is ``None`` for a stuffing arm (RAGAS is RAG-only), so the
    renderer prints a RAG-only marker rather than a blended zero.
    """

    arm: str
    count: int
    strict_pass_rate: float
    behavior_match: float
    cite_recall: float
    #: Judge point score, or ``None`` when the judge has not scored this arm.
    point_score: float | None
    #: RAGAS context recall, or ``None`` for a non-RAG (stuffing) arm.
    context_recall: float | None
    #: RAGAS context precision, or ``None`` for a non-RAG (stuffing) arm.
    context_precision: float | None


@dataclass(frozen=True, slots=True)
class FourArmSlice:
    """All four arms' cells for one slice (a behavior class, or ``all``)."""

    slice: str
    cells: tuple[ArmCell, ...]


@dataclass(frozen=True, slots=True)
class FourArmDashboard:
    """The full four-arm table: per-behavior-class slices plus the ``all`` row."""

    arm_order: tuple[str, ...]
    slices: tuple[FourArmSlice, ...]
    overall: tuple[ArmCell, ...]


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _cell(arm: str, column: ArmColumn, item_ids: Sequence[str]) -> ArmCell:
    by_id = {s.item_id: s for s in column.scores}
    scores = [by_id[i] for i in item_ids]

    point_values = [column.point_scores[i] for i in item_ids if i in column.point_scores]
    point_score = _mean(point_values) if point_values else None

    if is_rag_arm(arm):
        recalls = [
            column.context_metrics[i].context_recall
            for i in item_ids
            if i in column.context_metrics
        ]
        precisions = [
            column.context_metrics[i].context_precision
            for i in item_ids
            if i in column.context_metrics
        ]
        context_recall = _mean(recalls) if recalls else None
        context_precision = _mean(precisions) if precisions else None
    else:
        context_recall = None
        context_precision = None

    return ArmCell(
        arm=arm,
        count=len(scores),
        strict_pass_rate=_mean([1.0 if s.strict_pass else 0.0 for s in scores]),
        behavior_match=_mean([1.0 if s.behavior_match else 0.0 for s in scores]),
        cite_recall=_mean([s.cite_recall for s in scores]),
        point_score=point_score,
        context_recall=context_recall,
        context_precision=context_precision,
    )


def build_four_arm_dashboard(columns: Mapping[str, ArmColumn]) -> FourArmDashboard:
    """Build the four-arm table, paired by item id.

    Raises ``ValueError`` if the four arms do not cover the same set of item ids —
    a paired four-arm comparison over a mismatched item set is meaningless.
    """
    arms = tuple(arm for arm in ARM_ORDER if arm in columns)
    extra = [arm for arm in columns if arm not in ARM_ORDER]
    if extra:
        raise ValueError(f"unknown arm(s) in four-arm dashboard: {sorted(extra)}")

    id_sets = {arm: frozenset(s.item_id for s in columns[arm].scores) for arm in arms}
    reference = next(iter(id_sets.values()), frozenset())
    if any(ids != reference for ids in id_sets.values()):
        raise ValueError("all four arms must cover the same item ids (paired by item)")

    # Order item ids by first appearance on the first arm, and group by behavior
    # class from that arm (every arm sees the same items, paired).
    first_arm = arms[0]
    ordered_ids = [s.item_id for s in columns[first_arm].scores]
    behavior_of = {s.item_id: s.behavior_class for s in columns[first_arm].scores}

    order: list[str] = []
    groups: dict[str, list[str]] = {}
    for item_id in ordered_ids:
        cls = behavior_of[item_id]
        groups.setdefault(cls, []).append(item_id)
        if cls not in order:
            order.append(cls)

    slices = tuple(
        FourArmSlice(
            slice=cls,
            cells=tuple(_cell(arm, columns[arm], groups[cls]) for arm in arms),
        )
        for cls in order
    )
    overall = tuple(_cell(arm, columns[arm], ordered_ids) for arm in arms)
    return FourArmDashboard(arm_order=arms, slices=slices, overall=overall)


def _fmt_pct(value: float | None) -> str:
    return "  RAG-only" if value is None else f"{value:>8.0%}"


def render_four_arm_dashboard(dashboard: FourArmDashboard, *, run_name: str) -> str:
    """Render the four-arm table: one block per arm, paired by item, with RAGAS
    columns shown only for the RAG arms (and explicitly labelled RAG-only)."""
    lines: list[str] = [
        f"=== {run_name} — four-arm score dashboard (same model, paired by item) ===",
        "",
    ]

    header = (
        f"{'arm':<14}{'n':>4}  {'strict':>7}  {'point':>8}  {'behav':>8}  "
        f"{'cite-R':>8}  {'ctx-P':>8}  {'ctx-R':>8}"
    )

    def cell_row(cell: ArmCell) -> str:
        point = "       –" if cell.point_score is None else f"{cell.point_score:>8.0%}"
        return (
            f"{cell.arm:<14}{cell.count:>4}  {cell.strict_pass_rate:>7.2%}  {point}  "
            f"{cell.behavior_match:>8.0%}  {cell.cite_recall:>8.0%}  "
            f"{_fmt_pct(cell.context_precision)}  {_fmt_pct(cell.context_recall)}"
        )

    for s in dashboard.slices:
        lines.append(f"[{s.slice}] (n={s.cells[0].count if s.cells else 0})")
        lines.append(header)
        lines.append("-" * len(header))
        lines.extend(cell_row(c) for c in s.cells)
        lines.append("")

    lines.append("[all] — paired over every item")
    lines.append(header)
    lines.append("-" * len(header))
    lines.extend(cell_row(c) for c in dashboard.overall)
    lines.append("")
    lines.append(
        "All four arms run the SAME product model — arm gaps measure architecture, "
        "never model choice. Paired by item id; slices are never averaged together; "
        "there is no single overall number. ctx-P / ctx-R (RAGAS context "
        "precision/recall) are reported for the RAG arms ONLY (naive-rag, agent); "
        "the stuffing arms show RAG-only because they perform no retrieval to "
        "measure. (strict = strict pass, point = judge point score, cite-R = "
        "citation recall.)"
    )
    return "\n".join(lines)


__all__ = [
    "ARM_ORDER",
    "ArmColumn",
    "ArmCell",
    "FourArmSlice",
    "FourArmDashboard",
    "build_four_arm_dashboard",
    "render_four_arm_dashboard",
]
