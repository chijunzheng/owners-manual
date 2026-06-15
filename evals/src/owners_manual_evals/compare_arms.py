"""Run the naive-rag and agent arms over the SAME golden items and compare them
paired by item (issue #15 AC4).

This is the one command that produces the agent-vs-naive-rag score dashboard: it
selects the verified golden items once (dev split by default; holdout sealed
unless ``--include-holdout``), runs each item through BOTH arms — the frozen
naive-rag ``/answer`` path and the agent ``/chat`` path — scores each
deterministically with the SAME metric the single-arm dashboard uses
(:func:`score_item`, via :func:`run_items`), and renders the paired comparison
(:mod:`arm_dashboard`). Because both arms run the identical item set, the
strict-pass delta isolates the agent architecture, not the item mix (CONTEXT.md:
"paired arms attribute *where* lift comes from").

The pure orchestration (:func:`run_comparison`) injects both per-item answer
functions, so the whole loop is unit-tested offline; ``main`` wires the live HTTP
clients (naive-rag + agent) with trace-id propagation. The naive-rag arm is
consumed exactly as it is — this module never reshapes it.
"""

from __future__ import annotations

import sys
from collections.abc import Sequence
from dataclasses import dataclass

from .arm_dashboard import ArmDashboard, build_arm_dashboard, render_arm_dashboard
from .document_tree import DocumentTree
from .golden_item import GoldenItem
from .run_naive_rag import AnswerFn, ScoreSink, run_items, select_run_items


@dataclass(frozen=True, slots=True)
class ComparisonResult:
    """The paired comparison plus the golden items it was measured over."""

    dashboard: ArmDashboard
    items: tuple[GoldenItem, ...]


def run_comparison(
    *,
    items: Sequence[GoldenItem],
    documents: Sequence[DocumentTree],
    naive_answer: AnswerFn,
    agent_answer: AnswerFn,
    score_sink: ScoreSink,
) -> ComparisonResult:
    """Run the identical item set through both arms and build the paired dashboard.

    Each arm is scored by the same deterministic :func:`run_items` loop, so the
    two arms' :class:`ItemScore` lists are directly comparable; ``score_sink``
    receives both arms' scores (the live sink writes them to Langfuse, correlated
    by the per-arm service trace id).
    """
    naive = run_items(items=items, documents=documents, answer=naive_answer, score_sink=score_sink)
    agent = run_items(items=items, documents=documents, answer=agent_answer, score_sink=score_sink)
    dashboard = build_arm_dashboard(naive_rag=naive.scores, agent=agent.scores)
    return ComparisonResult(dashboard=dashboard, items=tuple(items))


# --- live CLI wiring -------------------------------------------------------


def _parse_args(argv: Sequence[str]):  # noqa: ANN202 — argparse.Namespace
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(
        prog="compare-arms",
        description="Run golden v0 through naive-rag AND the agent and print the paired score "
        "dashboard (same items, paired by item id).",
    )
    parser.add_argument(
        "--service-url",
        default="http://127.0.0.1:8787",
        help="Base URL of the running service (serves both /answer and /chat).",
    )
    parser.add_argument(
        "--include-holdout",
        action="store_true",
        help="Also run the sealed holdout split (default: dev split only).",
    )
    parser.add_argument(
        "--run-name",
        default="agent-vs-naive-rag-v0",
        help="Run name recorded on the Langfuse experiment / dashboard title.",
    )
    parser.add_argument(
        "--no-langfuse",
        action="store_true",
        help="Skip harness-side Langfuse export (still propagates a trace id per arm).",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """Live entry point: load golden v0, drive both arms, score, and print."""
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    # Lazy imports so the unit suite needs no SDK, no service, no Langfuse server.
    from .agent_live_runner import build_agent_answer  # noqa: PLC0415
    from .env_file import load_root_env  # noqa: PLC0415
    from .golden_v0 import load_golden_v0_documents, load_golden_v0_set  # noqa: PLC0415

    load_root_env()
    from .live_runner import (  # noqa: PLC0415
        build_live_answer,
        build_offline_answer,
        build_score_sink,
        finalize_langfuse,
        noop_score_sink,
    )

    documents = load_golden_v0_documents()
    golden = load_golden_v0_set()
    items = select_run_items(golden, include_holdout=args.include_holdout)

    split_label = "dev+holdout" if args.include_holdout else "dev"
    print(
        f"Running {len(items)} verified golden-v0 item(s) [{split_label} split] through "
        f"naive-rag AND the agent at {args.service_url}…",
        file=sys.stderr,
    )

    langfuse = None
    if args.no_langfuse:
        naive_answer = build_offline_answer(service_url=args.service_url, run_name=args.run_name)
        agent_answer = build_agent_answer(
            service_url=args.service_url, run_name=args.run_name, langfuse=None
        )
        score_sink = noop_score_sink
    else:
        try:
            naive_answer, langfuse = build_live_answer(
                service_url=args.service_url, run_name=args.run_name, documents=documents
            )
        except RuntimeError as error:
            print(
                f"Langfuse not configured: {error}\n"
                "Re-run with --no-langfuse to get the dashboard without trace export.",
                file=sys.stderr,
            )
            return 2
        agent_answer = build_agent_answer(
            service_url=args.service_url, run_name=args.run_name, langfuse=langfuse
        )
        score_sink = build_score_sink(langfuse)

    try:
        result = run_comparison(
            items=items,
            documents=documents,
            naive_answer=naive_answer,
            agent_answer=agent_answer,
            score_sink=score_sink,
        )
    finally:
        finalize_langfuse(langfuse)

    print(render_arm_dashboard(result.dashboard, run_name=f"{args.run_name} ({split_label})"))
    return 0


__all__ = ["ComparisonResult", "run_comparison", "main"]


if __name__ == "__main__":
    raise SystemExit(main())
