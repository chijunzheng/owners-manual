"""Release failure-digest tests (issue #21 AC4).

CONTEXT.md ("Disposition"): "The committed failure digest is a release-time
export — derived from Langfuse, never the primary record." The issue pins its
shape: "the clustered failure digest (stage × behavior class × corpus)".

So the digest is built from DISPOSITIONED-FAILURE records read back FROM Langfuse
(the disposition score + the trace's behavior/corpus/stage) — never from a run's
in-memory scores — and clustered on the three axes. These tests build it from
in-memory record fixtures standing in for what the Langfuse reader returns (the
reader itself is the live, mocked seam); the clustering and render are pure.
"""

from __future__ import annotations

from owners_manual_evals.disposition import FailureStage
from owners_manual_evals.failure_digest import (
    DispositionedFailure,
    build_failure_digest,
    render_failure_digest,
)


def _rec(
    item_id: str,
    *,
    stage: FailureStage,
    behavior_class: str = "answer",
    corpus: str = "tenancy",
    disposition: str = "bug",
) -> DispositionedFailure:
    return DispositionedFailure(
        item_id=item_id,
        trace_id=item_id + "-trace",
        behavior_class=behavior_class,  # type: ignore[arg-type]
        corpus=corpus,
        stage=stage,
        disposition=disposition,  # type: ignore[arg-type]
    )


def test_failures_cluster_on_stage_behavior_and_corpus() -> None:
    records = (
        _rec("f1", stage=FailureStage.RETRIEVAL, behavior_class="answer", corpus="tenancy"),
        _rec("f2", stage=FailureStage.RETRIEVAL, behavior_class="answer", corpus="tenancy"),
        _rec("f3", stage=FailureStage.SYNTHESIS, behavior_class="answer", corpus="tenancy"),
    )
    digest = build_failure_digest(records)

    # Two clusters: (retrieval, answer, tenancy)=2 and (synthesis, answer, tenancy)=1.
    by_key = {(c.stage, c.behavior_class, c.corpus): c for c in digest.clusters}
    assert by_key[(FailureStage.RETRIEVAL, "answer", "tenancy")].count == 2
    assert by_key[(FailureStage.SYNTHESIS, "answer", "tenancy")].count == 1


def test_cluster_carries_its_member_item_ids_and_disposition_tally() -> None:
    records = (
        _rec("f1", stage=FailureStage.RETRIEVAL, disposition="bug"),
        _rec("f2", stage=FailureStage.RETRIEVAL, disposition="rubric-wrong"),
        _rec("f3", stage=FailureStage.RETRIEVAL, disposition="bug"),
    )
    digest = build_failure_digest(records)

    cluster = digest.clusters[0]
    assert set(cluster.item_ids) == {"f1", "f2", "f3"}
    # The per-disposition tally within the cluster (the digest's analytic payload).
    assert cluster.disposition_counts == {"bug": 2, "rubric-wrong": 1}


def test_clusters_are_in_deterministic_order() -> None:
    # Stable ordering so the committed artifact has no spurious diffs run-to-run.
    records = (
        _rec(
            "f1",
            stage=FailureStage.SYNTHESIS,
            behavior_class="refuse-jurisdiction",
            corpus="tenancy",
        ),
        _rec("f2", stage=FailureStage.RETRIEVAL, behavior_class="answer", corpus="tenancy"),
        _rec("f3", stage=FailureStage.RETRIEVAL, behavior_class="answer", corpus="insurance"),
    )
    digest = build_failure_digest(records)
    keys = [(c.stage.value, c.behavior_class, c.corpus) for c in digest.clusters]
    assert keys == sorted(keys)


def test_total_is_the_count_of_dispositioned_failures() -> None:
    records = (
        _rec("f1", stage=FailureStage.RETRIEVAL),
        _rec("f2", stage=FailureStage.SYNTHESIS),
    )
    digest = build_failure_digest(records)
    assert digest.total == 2


def test_empty_digest_is_valid_a_clean_release_has_no_failures() -> None:
    digest = build_failure_digest(())
    assert digest.clusters == ()
    assert digest.total == 0


def test_render_states_it_is_derived_from_langfuse() -> None:
    # The committed artifact must SAY it is derived, never the primary record
    # (CONTEXT.md) — so a reader never mistakes it for the source of truth.
    records = (_rec("f1", stage=FailureStage.RETRIEVAL),)
    text = render_failure_digest(build_failure_digest(records), run_name="release-v0")
    lowered = text.lower()
    assert "derived" in lowered
    assert "langfuse" in lowered
    # The three clustering axes are named in the rendered table.
    assert "stage" in lowered
    assert "behavior" in lowered
    assert "corpus" in lowered


def test_render_lists_each_cluster_count() -> None:
    records = (
        _rec("f1", stage=FailureStage.RETRIEVAL, corpus="tenancy"),
        _rec("f2", stage=FailureStage.RETRIEVAL, corpus="tenancy"),
    )
    text = render_failure_digest(build_failure_digest(records), run_name="release-v0")
    assert "retrieval" in text
    assert "tenancy" in text
    assert "2" in text
