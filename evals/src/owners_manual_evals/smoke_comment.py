"""The report-only smoke score-table PR comment (issue #11).

CONTEXT.md ("Eval gate"): "report-only (PR score-table comment) through Phases
1-2". Every PR gets a smoke-tier comment built from the DETERMINISTIC dashboard
(no LLM judge), and the gate never blocks — it earns the right to block later (at
#24) by first proving it does not cry wolf. This module is the pure formatter:
:class:`~owners_manual_evals.dashboard.Dashboard` → Markdown comment body.

Two bodies, one stable marker:

* :func:`render_smoke_comment` — the real score table, when the slice executed.
* :func:`render_pending_comment` — an HONEST placeholder for when the slice could
  not run (no deployed service reachable from CI; the App Runner deploy is #24,
  itself blocked by #11). It fabricates no scores and restates that the gate does
  not block.

:data:`SMOKE_COMMENT_MARKER` is an HTML comment the workflow greps for, so it
edits one comment per PR instead of posting a new one every push.
"""

from __future__ import annotations

from .dashboard import Dashboard, SliceSummary

#: A hidden marker so the CI step can find-and-update a single comment per PR.
SMOKE_COMMENT_MARKER = "<!-- owners-manual-smoke-report -->"

#: The standing disclaimer: deterministic-only, report-only, non-blocking.
_REPORT_ONLY_NOTE = (
    "_Report-only smoke tier: deterministic metrics only, no LLM judge. "
    "This comment **does not block** merge — the gate earns the right to block "
    "later (#24) by first proving it does not cry wolf._"
)


def _pct(value: float) -> str:
    return f"{value:.2%}"


def _row(summary: SliceSummary) -> str:
    """One Markdown table row for a slice (or the overall row)."""
    return (
        f"| {summary.name} | {summary.count} | {_pct(summary.strict_pass_rate)} "
        f"| {_pct(summary.mean_behavior_match)} | {_pct(summary.mean_cite_precision)} "
        f"| {_pct(summary.mean_cite_recall)} | {_pct(summary.mean_retrieval_hit_rate)} |"
    )


def render_smoke_comment(
    dashboard: Dashboard,
    *,
    version: str,
    run_name: str,
    cost_estimate_usd: float,
    commit_sha: str | None = None,
) -> str:
    """Render the deterministic smoke dashboard as a Markdown PR comment.

    Reports the headline strict-pass rate, a row per behavior-class slice, and the
    overall row — each metric in its own column (CONTEXT.md: never one blended
    scalar; slices never averaged). The body carries the stable marker, the slice
    version, the per-merge cost, and the report-only / non-blocking disclaimer.
    """
    overall = dashboard.overall
    commit_line = f" · commit `{commit_sha}`" if commit_sha else ""

    header = "| slice | n | strict✓ | behavior | cite-P | cite-R | hit |"
    separator = "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"

    lines = [
        SMOKE_COMMENT_MARKER,
        f"### Smoke eval — `{version}` (report-only)",
        "",
        f"**Headline strict-pass rate (all): {_pct(overall.strict_pass_rate)}** "
        f"over {overall.count} item(s).",
        "",
        header,
        separator,
        *(_row(s) for s in dashboard.slices),
        _row(overall),
        "",
        f"Run `{run_name}`{commit_line} · slice `{version}` · "
        f"deterministic metrics, **no LLM judge** · est. cost ≈ "
        f"${cost_estimate_usd:.2f}/merge.",
        "",
        _REPORT_ONLY_NOTE,
    ]
    return "\n".join(lines)


def render_pending_comment(*, version: str, reason: str, commit_sha: str | None = None) -> str:
    """Render an honest 'slice did not execute' comment — no fabricated scores.

    Used when the live slice cannot run in CI (no reachable service/corpus yet;
    the App Runner deploy is #24). It states plainly that the slice did not run,
    gives the reason, and restates that the gate does not block — so a reader is
    never misled into thinking a blank table means a pass.
    """
    commit_line = f" · commit `{commit_sha}`" if commit_sha else ""
    lines = [
        SMOKE_COMMENT_MARKER,
        f"### Smoke eval — `{version}` (report-only)",
        "",
        f"The `{version}` smoke slice **did not run** this time{commit_line}.",
        "",
        f"Reason: {reason}",
        "",
        "No scores were produced, so none are reported (a blank table is not a "
        "pass). The live slice runs once a service is reachable from CI — the "
        "App Runner deploy is #24, which is itself blocked by this issue (#11).",
        "",
        _REPORT_ONLY_NOTE,
    ]
    return "\n".join(lines)


__all__ = [
    "SMOKE_COMMENT_MARKER",
    "render_pending_comment",
    "render_smoke_comment",
]
