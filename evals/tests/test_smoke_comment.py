"""The report-only smoke score-table PR comment formatter (issue #11).

CONTEXT.md ("Eval gate"): report-only through the early phases — every PR gets a
smoke-tier score-table comment, deterministic metrics only, no LLM judge, and the
gate never blocks. This module turns the deterministic :mod:`dashboard` into the
Markdown comment body the CI workflow posts, plus an honest "pending" body for
when the live slice cannot be executed (no deployed service reachable from CI
yet — the App Runner deploy is #24, blocked by #11).

These tests pin the comment as a PURE function of its inputs: a stable marker so
the workflow updates one comment instead of spamming, the versioned slice tag,
the report-only disclaimer, the headline strict-pass rate, a per-class table, and
— for the pending body — a clear statement that no scores ran and the gate still
does not block.
"""

from __future__ import annotations

from owners_manual_evals.dashboard import build_dashboard
from owners_manual_evals.metrics import ItemScore
from owners_manual_evals.smoke_comment import (
    SMOKE_COMMENT_MARKER,
    render_pending_comment,
    render_smoke_comment,
)


def _score(item_id: str, behavior_class: str, *, strict: bool) -> ItemScore:
    return ItemScore(
        item_id=item_id,
        behavior_class=behavior_class,
        behavior_match=strict,
        cite_precision=1.0 if strict else 0.0,
        cite_recall=1.0 if strict else 0.0,
        retrieval_hit_rate=1.0 if strict else 0.0,
        strict_pass=strict,
    )


def _dashboard():  # noqa: ANN202 — Dashboard
    scores = [
        _score("a1", "answer", strict=True),
        _score("a2", "answer", strict=False),
        _score("f1", "flag-void-clause", strict=True),
        _score("r1", "refuse-jurisdiction", strict=True),
    ]
    latencies = [{"total": 100.0} for _ in scores]
    costs = [0.25 for _ in scores]
    return build_dashboard(scores=scores, latencies_ms=latencies, cost_usd=costs)


def test_comment_carries_the_stable_marker() -> None:
    body = render_smoke_comment(
        _dashboard(), version="smoke-v1", run_name="smoke", cost_estimate_usd=1.0
    )
    # The marker lets the workflow find-and-update one comment per PR.
    assert SMOKE_COMMENT_MARKER in body


def test_comment_states_it_is_report_only_and_never_blocks() -> None:
    body = render_smoke_comment(
        _dashboard(), version="smoke-v1", run_name="smoke", cost_estimate_usd=1.0
    )
    low = body.lower()
    assert "report-only" in low
    assert "does not block" in low or "never blocks" in low


def test_comment_names_the_slice_version() -> None:
    body = render_smoke_comment(
        _dashboard(), version="smoke-v1", run_name="smoke", cost_estimate_usd=1.0
    )
    assert "smoke-v1" in body


def test_comment_reports_the_headline_strict_pass_rate() -> None:
    body = render_smoke_comment(
        _dashboard(), version="smoke-v1", run_name="smoke", cost_estimate_usd=1.0
    )
    # 2 of 4 strict-pass overall = 50.00%.
    assert "50.00%" in body
    assert "strict" in body.lower()


def test_comment_has_a_row_per_behavior_class_and_an_overall_row() -> None:
    body = render_smoke_comment(
        _dashboard(), version="smoke-v1", run_name="smoke", cost_estimate_usd=1.0
    )
    assert "answer" in body
    assert "flag-void-clause" in body
    assert "refuse-jurisdiction" in body
    # The all/overall row is present.
    assert "all" in body.lower()


def test_comment_is_markdown_table() -> None:
    body = render_smoke_comment(
        _dashboard(), version="smoke-v1", run_name="smoke", cost_estimate_usd=1.0
    )
    # A GitHub Markdown table: a header separator row of dashes and pipes.
    assert "|" in body
    assert "---" in body


def test_comment_states_no_llm_judge_and_the_cost() -> None:
    body = render_smoke_comment(
        _dashboard(), version="smoke-v1", run_name="smoke", cost_estimate_usd=1.0
    )
    low = body.lower()
    assert "no llm judge" in low or "deterministic" in low
    assert "$1" in body or "1.00" in body


def test_pending_comment_carries_marker_and_is_report_only() -> None:
    body = render_pending_comment(
        version="smoke-v1",
        reason="no deployed service reachable in CI yet (App Runner deploy is #24)",
    )
    assert SMOKE_COMMENT_MARKER in body
    low = body.lower()
    assert "report-only" in low
    assert "does not block" in low or "never blocks" in low


def test_pending_comment_is_honest_about_no_scores() -> None:
    body = render_pending_comment(
        version="smoke-v1",
        reason="no deployed service reachable in CI yet (App Runner deploy is #24)",
    )
    low = body.lower()
    # It must NOT fabricate a pass rate; it says the slice did not execute.
    assert "did not run" in low or "not executed" in low or "pending" in low
    assert "#24" in body
    assert "smoke-v1" in body
