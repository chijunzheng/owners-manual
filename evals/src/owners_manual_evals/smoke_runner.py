"""The report-only smoke runner (issue #11): run smoke-v1, render the PR comment.

The smoke gate runs the AGENT arm — the shipped pipeline the gate covers
(README, "Tiered": "a fixed 12-item agent slice"; CONTEXT.md, "Eval gate":
"Gates the `agent` pipeline only"). The committed :mod:`smoke_slice` runs through
the agent ``/chat`` endpoint, is scored with the SAME deterministic metric the
dashboards use (no LLM judge), and is rendered into the report-only comment
(:mod:`smoke_comment`).

The pure orchestration (:func:`run_smoke_slice`, :func:`build_run_comment`,
:func:`should_run_live`) injects the per-item answer function and the score sink,
so it is unit-tested offline against fakes. The live :func:`main` CLI — exercised
by the CI workflow, not the unit suite — wires the real agent client, and is
deliberately FAIL-SOFT: it is report-only, so it writes a comment body and exits
0 whatever the scores say, and writes an HONEST pending comment (never fabricated
scores) when no service is reachable.
"""

from __future__ import annotations

from collections.abc import Sequence

from .document_tree import DocumentTree
from .run_naive_rag import AnswerFn, RunResult, ScoreSink, run_items
from .smoke_comment import render_pending_comment, render_smoke_comment
from .smoke_slice import SmokeSlice

#: Substrings that mark a configured URL as a non-reachable placeholder, so a
#: shipped .env.example default is never mistaken for a live service.
_PLACEHOLDER_MARKERS = ("changeme", "placeholder")

#: The documented per-merge cost: deterministic metrics only, no LLM judge, real
#: Vertex calls against the GCP trial credit (README "Tiered": ~$1/merge).
SMOKE_COST_ESTIMATE_USD = 1.0


def run_smoke_slice(
    *,
    slice_: SmokeSlice,
    documents: Sequence[DocumentTree],
    answer: AnswerFn,
    score_sink: ScoreSink,
) -> RunResult:
    """Run the smoke slice through ``answer``, score deterministically, aggregate.

    Reuses the frozen :func:`run_naive_rag.run_items` paired-by-item loop so the
    smoke tier scores items exactly as the single-arm dashboard does — strict
    pass = behavior match AND all required cites satisfied. ``answer`` is the
    agent arm in production; a fake in tests.
    """
    return run_items(items=slice_.items, documents=documents, answer=answer, score_sink=score_sink)


def build_run_comment(
    result: RunResult,
    *,
    version: str,
    run_name: str,
    cost_estimate_usd: float = SMOKE_COST_ESTIMATE_USD,
    commit_sha: str | None = None,
) -> str:
    """Render a completed run's dashboard into the report-only Markdown comment."""
    return render_smoke_comment(
        result.dashboard,
        version=version,
        run_name=run_name,
        cost_estimate_usd=cost_estimate_usd,
        commit_sha=commit_sha,
    )


def should_run_live(service_url: str | None) -> bool:
    """Whether a live smoke run is possible against ``service_url``.

    ``False`` for a missing, blank, or placeholder URL — in which case the caller
    posts the honest pending comment rather than fabricating a run. The smoke
    slice's live execution needs a deployed, corpus-loaded agent service; that
    deploy is #24 (blocked by #11), so today this is expected to be ``False`` in
    CI and the gate stays report-only either way.
    """
    if service_url is None:
        return False
    trimmed = service_url.strip()
    if not trimmed:
        return False
    lowered = trimmed.lower()
    return not any(marker in lowered for marker in _PLACEHOLDER_MARKERS)


# --- live CLI wiring -------------------------------------------------------


def _parse_args(argv: Sequence[str]):  # pragma: no cover - live wiring  # noqa: ANN202
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(
        prog="run-smoke",
        description="Run the report-only smoke-v1 slice through the agent arm and write the "
        "PR score-table comment body. Report-only: always exits 0, never blocks merge.",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Path to write the Markdown comment body the workflow posts.",
    )
    parser.add_argument(
        "--run-name",
        default="smoke-v1",
        help="Run name recorded on the Langfuse experiment / shown in the comment.",
    )
    parser.add_argument(
        "--commit-sha",
        default=None,
        help="The PR head commit, shown in the comment for traceability.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no cover - live wiring
    """Live entry point: compose smoke-v1, run it (or write the pending comment).

    FAIL-SOFT by contract — the smoke gate is report-only, so this always returns
    0: a scoring shortfall informs via the comment, it never fails the job. When
    no service is reachable it writes the honest pending comment. The agent
    client, Langfuse, and score sink are imported lazily so importing this module
    needs no SDK or server.
    """
    import os  # noqa: PLC0415
    import sys  # noqa: PLC0415

    args = _parse_args(sys.argv[1:] if argv is None else argv)

    from .env_file import load_root_env  # noqa: PLC0415
    from .smoke_slice import SMOKE_SLICE_VERSION  # noqa: PLC0415

    load_root_env()
    service_url = os.environ.get("SMOKE_SERVICE_URL")

    if not should_run_live(service_url):
        reason = (
            "no deployed agent service is reachable from CI yet — SMOKE_SERVICE_URL is "
            "unset or a placeholder. The live smoke slice needs a corpus-loaded agent "
            "endpoint, stood up by the App Runner deploy (#24)."
        )
        body = render_pending_comment(
            version=SMOKE_SLICE_VERSION, reason=reason, commit_sha=args.commit_sha
        )
        _write_output(args.output, body)
        print(f"Smoke slice not executed: {reason}", file=sys.stderr)
        return 0

    # A service IS reachable — run the agent arm over the slice and score it.
    try:
        body = _run_live(
            service_url=service_url, run_name=args.run_name, commit_sha=args.commit_sha
        )
    except Exception as error:  # noqa: BLE001 - report-only: never fail the job
        # Report-only: a live failure informs via the comment, it does not block.
        body = render_pending_comment(
            version=SMOKE_SLICE_VERSION,
            reason=f"the live smoke run errored (reported, not blocking): {error}",
            commit_sha=args.commit_sha,
        )
        print(f"Smoke run errored (report-only, not blocking): {error}", file=sys.stderr)

    _write_output(args.output, body)
    return 0


def _run_live(  # pragma: no cover - live wiring
    *, service_url: str, run_name: str, commit_sha: str | None
) -> str:
    """Wire the live agent arm, run the slice, return the rendered comment body."""
    from .agent_live_runner import build_agent_answer  # noqa: PLC0415
    from .golden_v0 import load_golden_v0_documents  # noqa: PLC0415
    from .live_runner import noop_score_sink  # noqa: PLC0415
    from .smoke_slice import load_smoke_slice  # noqa: PLC0415

    slice_ = load_smoke_slice()
    documents = load_golden_v0_documents()
    # Trace export to a live Langfuse is optional for the report-only smoke tier;
    # the deterministic comment is the artifact. Propagate a deterministic trace
    # id (langfuse=None) so the service trace is still correlatable.
    answer = build_agent_answer(service_url=service_url, run_name=run_name, langfuse=None)
    result = run_smoke_slice(
        slice_=slice_, documents=documents, answer=answer, score_sink=noop_score_sink
    )
    return build_run_comment(
        result, version=slice_.version, run_name=run_name, commit_sha=commit_sha
    )


def _write_output(path: str, body: str) -> None:  # pragma: no cover - live wiring
    from pathlib import Path  # noqa: PLC0415

    Path(path).write_text(body, encoding="utf-8")


__all__ = [
    "SMOKE_COST_ESTIMATE_USD",
    "build_run_comment",
    "main",
    "run_smoke_slice",
    "should_run_live",
]


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
