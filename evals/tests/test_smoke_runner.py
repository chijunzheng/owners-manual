"""The report-only smoke runner orchestration (issue #11).

Ties the pure pieces together: the committed smoke-v2 slice runs through the
agent arm (the shipped pipeline the gate covers — README "Tiered"), is scored
with the SAME deterministic metric the dashboards use, and is rendered into the
report-only PR comment. The live agent answer function and the Langfuse score
sink are injected, so the orchestration is unit-tested offline against fakes; the
live CLI (covered by the workflow, not the unit suite) wires the real service.

These tests pin: the pipeline scores a fake arm's outcomes into the right
headline; refusal items (no cites) score on behavior alone; and the
run-live-vs-pending decision is honest — a missing or placeholder service URL
yields the pending path, never a fabricated run.
"""

from __future__ import annotations

from owners_manual_evals.run_naive_rag import ItemOutcome
from owners_manual_evals.smoke_comment import SMOKE_COMMENT_MARKER
from owners_manual_evals.smoke_runner import (
    build_run_comment,
    run_smoke_slice,
    should_run_live,
)
from owners_manual_evals.smoke_slice import SMOKE_SLICE_VERSION, load_smoke_slice


def _perfect_answer(item) -> ItemOutcome:  # noqa: ANN001
    """A fake arm that returns exactly the item's expected behavior and cites —
    every item strict-passes. Refusals carry no cites (vacuously perfect)."""
    return ItemOutcome(
        item_id=item.id,
        observed_behavior=item.behavior_class,
        candidate_cites=tuple(item.required_cites),
        retrieved_path_keys=(),
        latency_ms={"total": 100.0},
        cost_usd=0.05,
        trace_id=f"trace-{item.id}",
    )


def _wrong_behavior_answer(item) -> ItemOutcome:  # noqa: ANN001
    """A fake arm that always answers 'answer' — every refusal item fails the
    behavior match, every answer item with required cites still strict-passes
    only if its cites are offered (here they are not, so cite recall drops)."""
    return ItemOutcome(
        item_id=item.id,
        observed_behavior="answer",
        candidate_cites=(),
        retrieved_path_keys=(),
        latency_ms={"total": 100.0},
        cost_usd=0.05,
        trace_id=f"trace-{item.id}",
    )


def _sink_recorder():  # noqa: ANN202
    written: list[tuple[str | None, str, float]] = []

    def sink(*, trace_id, name, value):  # noqa: ANN001, ANN202
        written.append((trace_id, name, value))

    return written, sink


def test_run_smoke_slice_scores_a_perfect_arm_at_full_strict_pass() -> None:
    slice_ = load_smoke_slice()
    documents = _documents()
    written, sink = _sink_recorder()
    result = run_smoke_slice(
        slice_=slice_, documents=documents, answer=_perfect_answer, score_sink=sink
    )
    assert len(result.scores) == len(slice_.items)
    assert result.dashboard.overall.strict_pass_rate == 1.0
    # Deterministic scores were written for every item (trace correlation).
    assert written, "expected deterministic scores to be written to the sink"


def test_run_smoke_slice_penalizes_a_wrong_behavior_arm() -> None:
    slice_ = load_smoke_slice()
    documents = _documents()
    _, sink = _sink_recorder()
    result = run_smoke_slice(
        slice_=slice_, documents=documents, answer=_wrong_behavior_answer, score_sink=sink
    )
    # Refusals all mis-classified as 'answer' → behavior match fails for them, so
    # the overall strict-pass rate is strictly below 1.0.
    assert result.dashboard.overall.strict_pass_rate < 1.0


def test_build_run_comment_renders_the_versioned_report_only_table() -> None:
    slice_ = load_smoke_slice()
    documents = _documents()
    _, sink = _sink_recorder()
    result = run_smoke_slice(
        slice_=slice_, documents=documents, answer=_perfect_answer, score_sink=sink
    )
    body = build_run_comment(
        result, version=slice_.version, run_name="smoke", cost_estimate_usd=1.0
    )
    assert SMOKE_COMMENT_MARKER in body
    assert SMOKE_SLICE_VERSION in body
    assert "100.00%" in body
    assert "report-only" in body.lower()


def test_should_run_live_is_false_without_a_service_url() -> None:
    assert should_run_live(None) is False
    assert should_run_live("") is False
    assert should_run_live("   ") is False


def test_should_run_live_is_false_for_a_placeholder_url() -> None:
    # The .env.example ships placeholder values; a CHANGEME/placeholder URL must
    # not be treated as a reachable service.
    assert should_run_live("https://CHANGEME.example") is False
    assert should_run_live("http://localhost:8787/PLACEHOLDER") is False


def test_should_run_live_is_true_for_a_real_url() -> None:
    assert should_run_live("https://owners-manual.example.awsapprunner.com") is True


def _documents():  # noqa: ANN202
    from owners_manual_evals.golden_v0 import load_golden_v0_documents

    return load_golden_v0_documents()
