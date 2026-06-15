"""The naive-rag eval runner (issue #10): the one command that runs golden v0
through the naive-rag arm and prints the first scored dashboard.

This module owns the PURE orchestration — item selection (dev split by default;
holdout sealed unless ``--include-holdout``), paired-by-item execution, and
deterministic scoring into a dashboard — with the per-item answer function and
the Langfuse score sink injected, so the whole loop is unit-tested offline. The
``main`` CLI wires the live pieces: the golden-v0 loader, the HTTP service
client with trace-id propagation, and Langfuse Datasets/Experiments/Scores.

CONTEXT.md rules are enforced upstream (dashboard: strict pass headline, slices
never averaged) and here (verified-only via ``eval_run_items``; holdout sealed
from iteration via the default dev-only selection).
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from .dashboard import Dashboard, build_dashboard, render_dashboard
from .document_tree import DocumentTree
from .golden_item import GoldenItem
from .golden_loader import GoldenSet, assign_split, eval_run_items
from .metrics import ItemScore, score_item

#: Signature of the Langfuse score sink — kwargs-only so the live impl can add
#: fields (data type, comment) without breaking the pure runner's call sites.
ScoreSink = Callable[..., None]


@dataclass(frozen=True, slots=True)
class ItemOutcome:
    """What the service returned for one item — the input to deterministic
    scoring. The live answer function builds this from the HTTP response.

    ``answer_text`` is the produced answer prose; it is optional (defaults to
    empty) and ignored by the deterministic scorer, carried here so the offline
    LLM judge (#18) can grade an item's answer points BESIDE the deterministic
    metrics without reshaping the frozen single-arm/paired runners."""

    item_id: str
    observed_behavior: str
    candidate_cites: tuple
    retrieved_path_keys: tuple[str, ...]
    latency_ms: Mapping[str, float]
    cost_usd: float
    trace_id: str | None
    answer_text: str = ""


#: A per-item answer function: take a golden item, return its service outcome.
AnswerFn = Callable[[GoldenItem], ItemOutcome]


@dataclass(frozen=True, slots=True)
class RunResult:
    """The outcome of a whole run: per-item scores and the built dashboard."""

    scores: tuple[ItemScore, ...]
    dashboard: Dashboard


def select_run_items(golden: GoldenSet, *, include_holdout: bool) -> tuple[GoldenItem, ...]:
    """The verified items to run: dev split by default, the whole set when
    ``include_holdout``. Verified-only filtering is delegated to
    ``eval_run_items`` so an unverified item can never enter a run."""
    runnable = eval_run_items(golden)
    if include_holdout:
        return runnable
    sides = assign_split(golden.items)
    return tuple(item for item in runnable if sides.get(item.id) == "dev")


def run_items(
    *,
    items: Sequence[GoldenItem],
    documents: Sequence[DocumentTree],
    answer: AnswerFn,
    score_sink: ScoreSink,
) -> RunResult:
    """Run each item through ``answer`` (paired by item id), score it
    deterministically, write its scores to the sink (propagated by trace id),
    and aggregate the dashboard."""
    scores: list[ItemScore] = []
    latencies: list[Mapping[str, float]] = []
    costs: list[float] = []

    for item in items:
        outcome = answer(item)
        score = score_item(
            item,
            observed_behavior=outcome.observed_behavior,
            candidate_cites=outcome.candidate_cites,
            retrieved_path_keys=outcome.retrieved_path_keys,
            documents=documents,
        )
        scores.append(score)
        latencies.append(outcome.latency_ms)
        costs.append(outcome.cost_usd)

        # Write the deterministic scores, correlated to the service trace.
        for name, value in (
            ("strict_pass", 1.0 if score.strict_pass else 0.0),
            ("behavior_match", 1.0 if score.behavior_match else 0.0),
            ("cite_precision", score.cite_precision),
            ("cite_recall", score.cite_recall),
            ("retrieval_hit_rate", score.retrieval_hit_rate),
        ):
            score_sink(trace_id=outcome.trace_id, name=name, value=value)

    dashboard = build_dashboard(scores=scores, latencies_ms=latencies, cost_usd=costs)
    return RunResult(scores=tuple(scores), dashboard=dashboard)


# --- live CLI wiring -------------------------------------------------------


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="run-naive-rag",
        description="Run golden v0 through the naive-rag arm and print the score dashboard.",
    )
    parser.add_argument(
        "--service-url",
        default="http://127.0.0.1:8787",
        help="Base URL of the running naive-rag service (naive-rag:serve).",
    )
    parser.add_argument(
        "--include-holdout",
        action="store_true",
        help="Also run the sealed holdout split (default: dev split only).",
    )
    parser.add_argument(
        "--run-name",
        default="naive-rag-v0",
        help="Run name recorded on the Langfuse experiment.",
    )
    parser.add_argument(
        "--no-langfuse",
        action="store_true",
        help=(
            "Skip harness-side Langfuse export (still propagates a trace id to the "
            "service). Use when harness Langfuse keys are not provisioned."
        ),
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """Live entry point: load golden v0, drive the service, score, and print."""
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    # Lazy imports so the unit suite (which imports this module) needs no SDK,
    # no service, and no Langfuse server.
    from .env_file import load_root_env  # noqa: PLC0415
    from .golden_v0 import load_golden_v0_documents, load_golden_v0_set  # noqa: PLC0415

    # Mirror the TS CLIs: the root .env fills env gaps (process env wins), so
    # the documented one-command run needs no manual `source .env`.
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
        f"Running {len(items)} verified golden-v0 item(s) "
        f"[{split_label} split] through naive-rag at {args.service_url}…",
        file=sys.stderr,
    )

    if args.no_langfuse:
        answer = build_offline_answer(service_url=args.service_url, run_name=args.run_name)
        score_sink = noop_score_sink
        langfuse = None
    else:
        try:
            answer, langfuse = build_live_answer(
                service_url=args.service_url, run_name=args.run_name, documents=documents
            )
        except RuntimeError as error:
            print(
                f"Langfuse not configured: {error}\n"
                "Re-run with --no-langfuse to get the dashboard without trace export.",
                file=sys.stderr,
            )
            return 2
        score_sink = build_score_sink(langfuse)

    try:
        result = run_items(items=items, documents=documents, answer=answer, score_sink=score_sink)
    finally:
        finalize_langfuse(langfuse)

    print(render_dashboard(result.dashboard, run_name=f"{args.run_name} ({split_label})"))
    return 0


__all__ = [
    "ItemOutcome",
    "AnswerFn",
    "RunResult",
    "ScoreSink",
    "select_run_items",
    "run_items",
    "main",
]


if __name__ == "__main__":
    raise SystemExit(main())
