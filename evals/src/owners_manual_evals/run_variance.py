"""The variance-mode runner (issue #20): the one command that publishes the
statistical-honesty layer over the four arms.

It ties the seeded primitives together into one result:

1. run the variance-audit slice ``repeats`` times per arm and record the per-arm
   run-to-run noise floor (:func:`run_variance_audit`);
2. score every arm over the dev split, paired by item, and — only when holdout
   scores are supplied (release tier; sealed upstream by :mod:`eval_tier`) — over
   the holdout split too;
3. build the gap dashboard (:func:`build_gap_dashboard`): every published arm gap
   carries a paired bootstrap CI, gaps inside the measured noise floor are labeled
   within-noise, and the dev/holdout strict-pass rates sit side by side.

The per-split scoring and the per-repeat audit run are INJECTED, so the whole loop
is unit-tested offline against fakes; ``main`` wires the live four-arm clients and
the tier gate. Bootstrap resampling and audit-slice sampling are seeded throughout
— the published table is reproducible from ``seed``.
"""

from __future__ import annotations

import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass

from .gap_dashboard import GapDashboard, build_gap_dashboard
from .metrics import ItemScore
from .variance_audit import RunOnce, VarianceAudit, run_variance_audit

#: Score one arm over one split's item ids, returning its per-item scores.
ScoreSplit = Callable[..., tuple[ItemScore, ...]]


@dataclass(frozen=True, slots=True)
class VarianceComparisonResult:
    """The variance-mode output: the gap dashboard and the audit it was built on."""

    dashboard: GapDashboard
    variance_audit: VarianceAudit


def run_variance_comparison(
    *,
    arms: Sequence[str],
    dev_item_ids: Sequence[str],
    holdout_item_ids: Sequence[str] | None,
    score_split: ScoreSplit,
    run_audit_once: RunOnce,
    repeats: int = 5,
    seed: int,
    iterations: int = 2000,
    confidence: float = 0.95,
) -> VarianceComparisonResult:
    """Run the variance audit and the dev (and optional holdout) splits, then build
    the gap dashboard.

    ``score_split(arm=..., item_ids=...)`` scores one arm over one split's items;
    ``run_audit_once(arm=..., repeat=...)`` runs one audit repeat for an arm. The
    holdout is scored ONLY when ``holdout_item_ids`` is supplied — its absence is a
    sealed holdout (not run at this tier), surfaced as ``None`` columns downstream.
    """
    variance_audit = run_variance_audit(arms=arms, run_once=run_audit_once, repeats=repeats)

    dev_scores = {arm: score_split(arm=arm, item_ids=tuple(dev_item_ids)) for arm in arms}
    holdout_scores = (
        {arm: score_split(arm=arm, item_ids=tuple(holdout_item_ids)) for arm in arms}
        if holdout_item_ids is not None
        else None
    )

    dashboard = build_gap_dashboard(
        dev_scores=dev_scores,
        holdout_scores=holdout_scores,
        seed=seed,
        iterations=iterations,
        confidence=confidence,
        variance_audit=variance_audit,
    )
    return VarianceComparisonResult(dashboard=dashboard, variance_audit=variance_audit)


# --- live CLI wiring -------------------------------------------------------


def _parse_args(argv: Sequence[str]):  # noqa: ANN202 — argparse.Namespace
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(
        prog="run-variance",
        description="Variance mode: publish per-arm noise floor (audit slice x5), "
        "bootstrap CIs on every arm gap, within-noise labels, and dev/holdout "
        "columns. Holdout runs only at the release tier.",
    )
    parser.add_argument("--service-url", default="http://127.0.0.1:8787")
    parser.add_argument(
        "--tier",
        choices=("smoke", "full", "release"),
        default="full",
        help="Eval tier. Only 'release' may unseal the holdout (CONTEXT.md).",
    )
    parser.add_argument(
        "--include-holdout",
        action="store_true",
        help="Also score the holdout split. Permitted ONLY with --tier release.",
    )
    parser.add_argument("--run-name", default="variance-v0")
    parser.add_argument("--seed", type=int, default=1, help="Seed for the bootstrap + audit slice.")
    parser.add_argument("--iterations", type=int, default=2000, help="Bootstrap resamples per gap.")
    parser.add_argument("--repeats", type=int, default=5, help="Audit-slice repeats per arm.")
    parser.add_argument("--audit-size", type=int, default=15, help="Audit-slice item count.")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no cover - live wiring
    """Live entry point: gate the tier, sample the audit slice, run the four arms
    over dev (and the holdout at the release tier), and print the gap dashboard.

    The four-arm live answers are reused from the #18 wiring; here we add the
    seeded variance audit and the gap dashboard. The tier gate raises if a
    non-release tier asks for the holdout, so the overfit detector cannot leak.
    """
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    from .eval_tier import Tier, select_tier_items  # noqa: PLC0415
    from .four_arm_dashboard import ARM_ORDER  # noqa: PLC0415
    from .golden_v0 import load_golden_v0_documents, load_golden_v0_set  # noqa: PLC0415
    from .variance_audit import select_variance_slice  # noqa: PLC0415

    tier = Tier(args.tier)
    golden = load_golden_v0_set()
    documents = load_golden_v0_documents()

    try:
        dev_items = select_tier_items(golden, tier=tier, include_holdout=False)
        run_items = select_tier_items(golden, tier=tier, include_holdout=args.include_holdout)
    except ValueError as error:
        print(f"Tier/holdout error: {error}", file=sys.stderr)
        return 2

    holdout_items = tuple(item for item in run_items if item.id not in {i.id for i in dev_items})
    dev_ids = tuple(item.id for item in dev_items)
    holdout_ids = tuple(item.id for item in holdout_items) if args.include_holdout else None

    audit_ids = select_variance_slice(dev_ids, size=args.audit_size, seed=args.seed)

    print(
        f"Variance mode [{tier.value} tier]: {len(dev_ids)} dev item(s), "
        f"audit slice of {len(audit_ids)} x{args.repeats} repeats, "
        f"{'with' if holdout_ids else 'no'} holdout, at {args.service_url}…",
        file=sys.stderr,
    )

    score_split = _build_live_score_split(
        service_url=args.service_url,
        documents=documents,
        run_name=args.run_name,
        items=run_items,
    )

    # The audit re-runs the SAME scorer over the audit slice each repeat; the
    # arm's own nondeterminism (no temperature control, ADR 0005) supplies the
    # run-to-run spread the noise floor measures.
    def run_audit_once(*, arm: str, repeat: int) -> tuple[ItemScore, ...]:
        _ = repeat
        return score_split(arm=arm, item_ids=audit_ids)

    result = run_variance_comparison(
        arms=ARM_ORDER,
        dev_item_ids=dev_ids,
        holdout_item_ids=holdout_ids,
        score_split=score_split,
        run_audit_once=run_audit_once,
        repeats=args.repeats,
        seed=args.seed,
        iterations=args.iterations,
    )

    from .gap_dashboard import render_gap_dashboard, render_noise_floor  # noqa: PLC0415

    run_label = f"{args.run_name} ({tier.value})"
    # Publish BOTH: the gap dashboard (CIs + within-noise labels) and the per-arm
    # noise floor those labels are judged against, so the thresholds are auditable.
    print(render_gap_dashboard(result.dashboard, run_name=run_label))
    print()
    print(render_noise_floor(result.variance_audit, run_name=run_label))
    return 0


def _build_live_score_split(*, service_url, documents, run_name, items):  # pragma: no cover - live
    """Bind the #18 four-arm answer functions into a per-split scorer.

    Builds the four live :data:`AnswerFn`s (stuff, stuff-oracle, naive-rag, agent)
    once, then returns a ``score_split(arm=..., item_ids=...)`` that runs the named
    arm over those items and scores each with the SAME deterministic
    :func:`score_item` the dashboards use — so the variance layer reuses the frozen
    arms exactly, never reshaping them. Trace export is omitted here (the audit
    re-runs items many times); the headline gap CIs are the artifact. The
    naive-rag arm reuses the offline answer (HTTP without Langfuse export), since
    the audit's repeated runs make per-call trace export noise, not signal."""
    from .agent_live_runner import build_agent_answer  # noqa: PLC0415
    from .live_runner import build_offline_answer  # noqa: PLC0415
    from .metrics import score_item  # noqa: PLC0415
    from .run_naive_rag import AnswerFn  # noqa: PLC0415
    from .stuff_client import StuffClient  # noqa: PLC0415
    from .stuff_live_runner import build_stuff_answer, build_stuff_oracle_answer  # noqa: PLC0415

    by_id = {item.id: item for item in items}
    stuff_client = StuffClient(base_url=service_url)
    answer_fns: dict[str, AnswerFn] = {
        "stuff": build_stuff_answer(client=stuff_client, run_name=run_name),
        "stuff-oracle": build_stuff_oracle_answer(client=stuff_client, run_name=run_name),
        "naive-rag": build_offline_answer(service_url=service_url, run_name=run_name),
        "agent": build_agent_answer(service_url=service_url, run_name=run_name, langfuse=None),
    }

    def score_split(*, arm: str, item_ids) -> tuple[ItemScore, ...]:
        answer = answer_fns[arm]
        scores: list[ItemScore] = []
        for item_id in item_ids:
            item = by_id[item_id]
            outcome = answer(item)
            scores.append(
                score_item(
                    item,
                    observed_behavior=outcome.observed_behavior,
                    candidate_cites=outcome.candidate_cites,
                    retrieved_path_keys=outcome.retrieved_path_keys,
                    documents=documents,
                )
            )
        return tuple(scores)

    return score_split


__all__ = [
    "ScoreSplit",
    "VarianceComparisonResult",
    "run_variance_comparison",
    "main",
]


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
