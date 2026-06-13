"""The score dashboard (issue #10 AC1; CONTEXT.md, "Score dashboard").

Published shape, per arm × slice: strict pass rate is the headline (behavior
match + all required cites), citation precision/recall are reported, and so are
cost/latency. Two hard rules from CONTEXT.md are enforced structurally here:

* metrics are **never collapsed into one blended scalar** — there is no
  "overall score"; the table reports each metric in its own column;
* **slices are never averaged together** — the ``all`` row is computed over
  items, not as a mean of slice means, so unequal slice sizes never distort it.

Slices are the five behavior classes that appear in the run; the ``all`` row is
the whole run. Latency is summarized as a median (p50) so a single slow item
does not move the headline; cost is summed.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from statistics import median

from .metrics import ItemScore


@dataclass(frozen=True, slots=True)
class SliceSummary:
    """One row of the dashboard: a named slice (a behavior class, or ``all``)."""

    name: str
    count: int
    strict_pass_rate: float
    mean_behavior_match: float
    mean_cite_precision: float
    mean_cite_recall: float
    mean_retrieval_hit_rate: float
    p50_latency_ms: float
    total_cost_usd: float


@dataclass(frozen=True, slots=True)
class Dashboard:
    """The full dashboard: per-behavior-class slices plus the ``all`` row."""

    slices: tuple[SliceSummary, ...]
    overall: SliceSummary


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _summarize(
    name: str,
    scores: Sequence[ItemScore],
    latencies_ms: Sequence[Mapping[str, float]],
    cost_usd: Sequence[float],
) -> SliceSummary:
    totals = [lat.get("total", 0.0) for lat in latencies_ms]
    return SliceSummary(
        name=name,
        count=len(scores),
        strict_pass_rate=_mean([1.0 if s.strict_pass else 0.0 for s in scores]),
        mean_behavior_match=_mean([1.0 if s.behavior_match else 0.0 for s in scores]),
        mean_cite_precision=_mean([s.cite_precision for s in scores]),
        mean_cite_recall=_mean([s.cite_recall for s in scores]),
        mean_retrieval_hit_rate=_mean([s.retrieval_hit_rate for s in scores]),
        p50_latency_ms=median(totals) if totals else 0.0,
        total_cost_usd=sum(cost_usd),
    )


def build_dashboard(
    *,
    scores: Sequence[ItemScore],
    latencies_ms: Sequence[Mapping[str, float]],
    cost_usd: Sequence[float],
) -> Dashboard:
    """Aggregate per-item scores into per-slice rows and the ``all`` row.

    ``scores``, ``latencies_ms``, and ``cost_usd`` are index-aligned per item.
    """
    if not (len(scores) == len(latencies_ms) == len(cost_usd)):
        raise ValueError("scores, latencies_ms, and cost_usd must be the same length")

    # Group indices by behavior class, preserving first-seen order.
    order: list[str] = []
    groups: dict[str, list[int]] = {}
    for index, score in enumerate(scores):
        groups.setdefault(score.behavior_class, []).append(index)
        if score.behavior_class not in order:
            order.append(score.behavior_class)

    slices = tuple(
        _summarize(
            name,
            [scores[i] for i in groups[name]],
            [latencies_ms[i] for i in groups[name]],
            [cost_usd[i] for i in groups[name]],
        )
        for name in order
    )
    overall = _summarize("all", scores, latencies_ms, cost_usd)
    return Dashboard(slices=slices, overall=overall)


def render_dashboard(dashboard: Dashboard, *, run_name: str) -> str:
    """Render the dashboard as an aligned console table with a headline line."""
    header = (
        f"{'slice':<24}{'n':>4}  {'strict':>7}  {'behav':>6}  "
        f"{'cite-P':>7}  {'cite-R':>7}  {'hit':>6}  {'p50 ms':>8}  {'cost $':>8}"
    )

    def row(s: SliceSummary) -> str:
        return (
            f"{s.name:<24}{s.count:>4}  {s.strict_pass_rate:>7.2%}  "
            f"{s.mean_behavior_match:>6.0%}  {s.mean_cite_precision:>7.2%}  "
            f"{s.mean_cite_recall:>7.2%}  {s.mean_retrieval_hit_rate:>6.0%}  "
            f"{s.p50_latency_ms:>8.0f}  {s.total_cost_usd:>8.4f}"
        )

    overall = dashboard.overall
    lines = [
        f"=== {run_name} — naive-rag score dashboard ===",
        f"HEADLINE strict pass rate (all): {overall.strict_pass_rate:.2%} "
        f"over {overall.count} item(s)",
        "",
        header,
        "-" * len(header),
        *(row(s) for s in dashboard.slices),
        "-" * len(header),
        row(overall),
        "",
        "Slices are never averaged together; the 'all' row is computed over items. "
        "Each metric stands in its own column — there is no single overall number.",
    ]
    return "\n".join(lines)


__all__ = ["SliceSummary", "Dashboard", "build_dashboard", "render_dashboard"]
