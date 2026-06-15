"""Run the FOUR arms over the same golden items and build the four-arm table (#18).

Extends :mod:`compare_arms` (naive-rag + agent, paired) to the full four arms:
stuff, stuff-oracle, naive-rag, agent — all on the SAME product model (ADR 0005),
paired BY ITEM. For each arm it scores every item deterministically with the SAME
metric the single-arm dashboard uses (:func:`score_item`), runs the OFFLINE LLM
judge against the produced answer (:func:`judge_item`) and joins the verdicts to
the exact trace (:func:`write_judge_scores`), and — for the RAG arms ONLY —
evaluates RAGAS context metrics. The four-arm dashboard reports them side by side,
slices never blended, with the RAGAS columns marked RAG-only.

The pure orchestration injects the four answer functions, the judge client, and
the RAGAS evaluator, so the whole loop is unit-tested offline against fakes; the
``main`` CLI wires the live HTTP clients (naive-rag, agent, stuff, stuff-oracle),
the live judge (Claude via the Agent SDK), and the live RAGAS evaluator. The frozen
naive-rag and agent arms are consumed exactly as they are — never reshaped.
"""

from __future__ import annotations

import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .document_tree import DocumentTree
from .four_arm_dashboard import (
    ARM_ORDER,
    ArmColumn,
    FourArmDashboard,
    build_four_arm_dashboard,
)
from .golden_item import GoldenItem
from .judge import JudgeClient, judge_item
from .judge_scores import write_judge_scores
from .metrics import ItemScore, score_item
from .ragas_metrics import ContextEvaluator, ContextMetrics, evaluate_context_metrics
from .run_naive_rag import AnswerFn, ItemOutcome, ScoreSink

#: The deterministic scores written per item, beside the judge's (issue #10).
_DETERMINISTIC_SCORES = ("strict_pass", "behavior_match", "cite_precision", "cite_recall")


@dataclass(frozen=True, slots=True)
class FourArmComparisonResult:
    """The four-arm dashboard plus the golden items it was measured over."""

    dashboard: FourArmDashboard
    items: tuple[GoldenItem, ...]


def _write_deterministic(score: ItemScore, trace_id: str | None, sink: ScoreSink) -> None:
    if trace_id is None:
        return
    for name, value in (
        ("strict_pass", 1.0 if score.strict_pass else 0.0),
        ("behavior_match", 1.0 if score.behavior_match else 0.0),
        ("cite_precision", score.cite_precision),
        ("cite_recall", score.cite_recall),
        ("retrieval_hit_rate", score.retrieval_hit_rate),
    ):
        sink(trace_id=trace_id, name=name, value=value)


def _run_arm(
    *,
    arm: str,
    items: Sequence[GoldenItem],
    documents: Sequence[DocumentTree],
    answer: AnswerFn,
    contexts: Mapping[str, Sequence[str]],
    judge_client: JudgeClient,
    context_evaluator: ContextEvaluator,
    score_sink: ScoreSink,
) -> ArmColumn:
    """Run one arm over the items: deterministic score + judge + (RAG-only) RAGAS,
    writing both score families to each item's exact trace."""
    scores: list[ItemScore] = []
    point_scores: dict[str, float] = {}
    context_metrics: dict[str, ContextMetrics] = {}

    for item in items:
        outcome: ItemOutcome = answer(item)
        score = score_item(
            item,
            observed_behavior=outcome.observed_behavior,
            candidate_cites=outcome.candidate_cites,
            retrieved_path_keys=outcome.retrieved_path_keys,
            documents=documents,
        )
        scores.append(score)
        _write_deterministic(score, outcome.trace_id, score_sink)

        # The OFFLINE judge, BESIDE the deterministic metrics, joined to the trace.
        verdict = judge_item(item, answer_text=outcome.answer_text, judge_client=judge_client)
        point_scores[item.id] = verdict.point_score
        write_judge_scores(verdict, trace_id=outcome.trace_id, score_sink=score_sink)

        # RAGAS context metrics — RAG arms only (None for stuffing arms).
        metrics = evaluate_context_metrics(
            arm=arm,
            question=item.question,
            contexts=contexts.get(item.id, ()),
            answer=outcome.answer_text,
            required_cites=tuple(outcome.retrieved_path_keys),
            evaluator=context_evaluator,
        )
        if metrics is not None:
            context_metrics[item.id] = metrics

    return ArmColumn(
        scores=tuple(scores),
        point_scores=point_scores,
        context_metrics=context_metrics,
    )


def run_four_arm_comparison(
    *,
    items: Sequence[GoldenItem],
    documents: Sequence[DocumentTree],
    answers: Mapping[str, AnswerFn],
    contexts_by_arm: Mapping[str, Mapping[str, Sequence[str]]],
    judge_client: JudgeClient,
    context_evaluator: ContextEvaluator,
    score_sink: ScoreSink,
) -> FourArmComparisonResult:
    """Run the identical item set through all four arms and build the four-arm table.

    Raises ``ValueError`` if any of the four arms is missing an answer function — a
    four-arm comparison needs all four.
    """
    missing = [arm for arm in ARM_ORDER if arm not in answers]
    if missing:
        raise ValueError(f"four-arm comparison is missing answer function(s) for arm(s): {missing}")

    columns = {
        arm: _run_arm(
            arm=arm,
            items=items,
            documents=documents,
            answer=answers[arm],
            contexts=contexts_by_arm.get(arm, {}),
            judge_client=judge_client,
            context_evaluator=context_evaluator,
            score_sink=score_sink,
        )
        for arm in ARM_ORDER
    }
    dashboard = build_four_arm_dashboard(columns)
    return FourArmComparisonResult(dashboard=dashboard, items=tuple(items))


# --- live CLI wiring -------------------------------------------------------


def _parse_args(argv: Sequence[str]):  # noqa: ANN202 — argparse.Namespace
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(
        prog="compare-four-arms",
        description="Run golden v0 through all four arms (stuff, stuff-oracle, naive-rag, agent) "
        "and print the four-arm score dashboard (same model, paired by item).",
    )
    parser.add_argument("--service-url", default="http://127.0.0.1:8787")
    parser.add_argument("--include-holdout", action="store_true")
    parser.add_argument("--run-name", default="four-arm-v0")
    parser.add_argument(
        "--no-langfuse",
        action="store_true",
        help="Skip harness-side Langfuse export (still propagates a trace id per arm).",
    )
    parser.add_argument(
        "--no-judge",
        action="store_true",
        help="Skip the LLM judge (deterministic + RAGAS only). Use before the SDK credit is wired.",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no cover - live wiring
    """Live entry point: load golden v0, drive all four arms, score, judge, print.

    The judge and RAGAS live bindings are imported lazily; ``--no-judge`` swaps the
    judge for a no-op so the table still renders before the Agent SDK credit is
    wired (the judge seam is mocked in tests regardless).
    """
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    from .agent_client import AgentChatClient  # noqa: PLC0415
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
    from .run_naive_rag import select_run_items  # noqa: PLC0415
    from .stuff_client import StuffClient  # noqa: PLC0415
    from .stuff_live_runner import build_stuff_answer, build_stuff_oracle_answer  # noqa: PLC0415

    documents = load_golden_v0_documents()
    golden = load_golden_v0_set()
    items = select_run_items(golden, include_holdout=args.include_holdout)

    split_label = "dev+holdout" if args.include_holdout else "dev"
    print(
        f"Running {len(items)} verified golden-v0 item(s) [{split_label} split] through ALL FOUR "
        f"arms at {args.service_url}…",
        file=sys.stderr,
    )

    langfuse = None
    _ = AgentChatClient  # the agent answer builder constructs its own client
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
                f"Langfuse not configured: {error}\nRe-run with --no-langfuse.",
                file=sys.stderr,
            )
            return 2
        agent_answer = build_agent_answer(
            service_url=args.service_url, run_name=args.run_name, langfuse=langfuse
        )
        score_sink = build_score_sink(langfuse)

    stuff_client = StuffClient(base_url=args.service_url)
    answers = {
        "stuff": build_stuff_answer(client=stuff_client, run_name=args.run_name),
        "stuff-oracle": build_stuff_oracle_answer(client=stuff_client, run_name=args.run_name),
        "naive-rag": naive_answer,
        "agent": agent_answer,
    }

    judge_client = _resolve_judge(no_judge=args.no_judge)
    context_evaluator = _resolve_context_evaluator()

    try:
        result = run_four_arm_comparison(
            items=items,
            documents=documents,
            answers=answers,
            contexts_by_arm={},  # contexts wired from /retrieve/debug when RAGAS goes live
            judge_client=judge_client,
            context_evaluator=context_evaluator,
            score_sink=score_sink,
        )
    finally:
        finalize_langfuse(langfuse)

    from .four_arm_dashboard import render_four_arm_dashboard  # noqa: PLC0415

    print(render_four_arm_dashboard(result.dashboard, run_name=f"{args.run_name} ({split_label})"))
    return 0


def _resolve_judge(*, no_judge: bool):  # pragma: no cover - live wiring
    """The live judge (Claude via the Agent SDK), or a no-op when ``--no-judge``."""
    from .judge import scripted_judge  # noqa: PLC0415

    if no_judge:
        # A judge that credits nothing — leaves the point-score column at 0 until
        # the Agent SDK credit is wired. The seam is identical to the live judge.
        return scripted_judge({})
    from .judge_live import build_claude_judge  # noqa: PLC0415

    return build_claude_judge()


def _resolve_context_evaluator():  # pragma: no cover - live wiring
    """The live RAGAS evaluator (lazy import keeps ragas out of the unit suite)."""
    from .ragas_live import build_ragas_context_evaluator  # noqa: PLC0415

    return build_ragas_context_evaluator()


__all__ = ["FourArmComparisonResult", "run_four_arm_comparison", "main"]


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
