"""The release failure digest (issue #21 AC4): the clustered, derived export.

CONTEXT.md ("Disposition"): "The committed failure digest is a release-time
export — derived from Langfuse, never the primary record." The issue pins its
shape: "the clustered failure digest (stage × behavior class × corpus)".

This module clusters DISPOSITIONED-FAILURE records on those three axes and
renders the digest. Its input is what a Langfuse reader returns — each failed
item's disposition score joined to the trace's behavior class, corpus, and
failing stage — so the digest is genuinely DERIVED: rebuilding it re-reads
Langfuse, it never authors the verdicts itself. The clustering and the render are
pure; the live read (the real ``annotation_queues`` / score API) is the mocked
seam in :mod:`live_annotation_queue`.

Clusters are emitted in a deterministic key order so the committed artifact has
no spurious run-to-run diffs.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .disposition import Disposition, FailureStage
from .golden_item import BehaviorClass


@dataclass(frozen=True, slots=True)
class DispositionedFailure:
    """One failed item read back FROM Langfuse: its trace, the behavior class,
    corpus, and failing stage on that trace, plus the disposition an annotator
    set. The digest's atomic input — never authored here, only read."""

    item_id: str
    trace_id: str
    behavior_class: BehaviorClass
    corpus: str
    stage: FailureStage
    disposition: Disposition


@dataclass(frozen=True, slots=True)
class FailureCluster:
    """One (stage × behavior class × corpus) cell of the digest: how many failed
    there, which items, and the per-disposition tally within the cell."""

    stage: FailureStage
    behavior_class: BehaviorClass
    corpus: str
    count: int
    item_ids: tuple[str, ...]
    disposition_counts: Mapping[str, int]


@dataclass(frozen=True, slots=True)
class FailureDigest:
    """The release digest: the clustered failures and their total. An empty
    digest (a clean release) is valid — no clusters, total zero."""

    clusters: tuple[FailureCluster, ...]
    total: int


def _cluster_key(failure: DispositionedFailure) -> tuple[str, str, str]:
    """The deterministic sort key for a failure's cluster (stage, behavior,
    corpus) — string-valued so the committed artifact orders stably."""
    return (failure.stage.value, failure.behavior_class, failure.corpus)


def build_failure_digest(failures: Sequence[DispositionedFailure]) -> FailureDigest:
    """Cluster dispositioned failures on stage × behavior class × corpus.

    Each cluster carries its member item ids (sorted) and a per-disposition tally.
    Clusters are returned in deterministic key order; the total is the count of
    failures. An empty input yields an empty digest (a clean release).
    """
    grouped: dict[tuple[str, str, str], list[DispositionedFailure]] = {}
    for failure in failures:
        grouped.setdefault(_cluster_key(failure), []).append(failure)

    clusters = tuple(
        FailureCluster(
            stage=members[0].stage,
            behavior_class=members[0].behavior_class,
            corpus=members[0].corpus,
            count=len(members),
            item_ids=tuple(sorted(member.item_id for member in members)),
            disposition_counts=dict(Counter(member.disposition for member in members)),
        )
        for _key, members in sorted(grouped.items())
    )
    return FailureDigest(clusters=clusters, total=len(failures))


def _fmt_disposition_counts(counts: Mapping[str, int]) -> str:
    return ", ".join(f"{name}:{count}" for name, count in sorted(counts.items()))


def render_failure_digest(digest: FailureDigest, *, run_name: str) -> str:
    """Render the release failure digest as committed text.

    States up front that it is DERIVED from Langfuse and not the primary record
    (CONTEXT.md), then a table clustered on the three axes — stage × behavior ×
    corpus — with each cell's count, disposition tally, and member items.
    """
    lines = [
        f"=== {run_name} — failure digest (stage × behavior × corpus) ===",
        "",
        "Derived artifact: this digest is EXPORTED from Langfuse dispositions at "
        "release time. Langfuse is the primary record; this file is a derived view, "
        "never the source of truth (CONTEXT.md, Disposition).",
        "",
        f"{digest.total} dispositioned failure(s) across {len(digest.clusters)} cluster(s).",
        "",
    ]

    if not digest.clusters:
        lines.append("No dispositioned failures — a clean release.")
        return "\n".join(lines)

    header = f"{'stage':<10}{'behavior class':<26}{'corpus':<12}{'#':>4}  dispositions / items"
    lines.append(header)
    lines.append("-" * len(header))
    for cluster in digest.clusters:
        items = ", ".join(cluster.item_ids)
        tally = _fmt_disposition_counts(cluster.disposition_counts)
        lines.append(
            f"{cluster.stage.value:<10}{cluster.behavior_class:<26}{cluster.corpus:<12}"
            f"{cluster.count:>4}  [{tally}] {items}"
        )
    return "\n".join(lines)


__all__ = [
    "DispositionedFailure",
    "FailureCluster",
    "FailureDigest",
    "build_failure_digest",
    "render_failure_digest",
]
