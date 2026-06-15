"""Four-arm dashboard tests (issue #18).

The dashboard grows from the paired agent-vs-naive-rag table to the full FOUR-arm
table: stuff, stuff-oracle, naive-rag, agent — all on the SAME product model,
paired BY ITEM, slices never blended. RAGAS context columns appear for the RAG
arms only (naive-rag, agent) and the table SAYS so; the stuffing arms show a
RAG-only marker, never a blended number. The judge's point score sits beside the
deterministic strict pass per arm.
"""

from __future__ import annotations

from owners_manual_evals.four_arm_dashboard import (
    ArmColumn,
    build_four_arm_dashboard,
    render_four_arm_dashboard,
)
from owners_manual_evals.metrics import ItemScore
from owners_manual_evals.ragas_metrics import ContextMetrics


def _score(item_id: str, *, strict: bool, recall: float = 1.0) -> ItemScore:
    return ItemScore(
        item_id=item_id,
        behavior_class="answer",
        behavior_match=True,
        cite_precision=1.0,
        cite_recall=recall,
        retrieval_hit_rate=recall,
        strict_pass=strict,
    )


def _arm(strict_by_item: dict[str, bool]) -> tuple[ItemScore, ...]:
    return tuple(_score(i, strict=s) for i, s in strict_by_item.items())


def _columns() -> dict[str, ArmColumn]:
    items = {"a1": True, "a2": False}
    return {
        "stuff": ArmColumn(scores=_arm(items)),
        "stuff-oracle": ArmColumn(scores=_arm({"a1": True, "a2": True})),
        "naive-rag": ArmColumn(
            scores=_arm({"a1": False, "a2": False}),
            context_metrics={
                "a1": ContextMetrics(0.5, 0.5),
                "a2": ContextMetrics(0.5, 0.5),
            },
        ),
        "agent": ArmColumn(
            scores=_arm({"a1": True, "a2": True}),
            context_metrics={
                "a1": ContextMetrics(0.9, 0.9),
                "a2": ContextMetrics(0.9, 0.9),
            },
        ),
    }


def test_dashboard_has_all_four_arms() -> None:
    dashboard = build_four_arm_dashboard(_columns())
    assert tuple(dashboard.arm_order) == ("stuff", "stuff-oracle", "naive-rag", "agent")


def test_dashboard_pairs_by_item_and_rejects_mismatched_item_sets() -> None:
    cols = _columns()
    cols["agent"] = ArmColumn(scores=_arm({"a1": True}))  # missing a2
    try:
        build_four_arm_dashboard(cols)
    except ValueError as error:
        assert "same item" in str(error).lower() or "paired" in str(error).lower()
    else:  # pragma: no cover
        raise AssertionError("expected a ValueError for mismatched item sets")


def test_overall_strict_pass_is_per_arm_over_items() -> None:
    dashboard = build_four_arm_dashboard(_columns())
    strict = {row.arm: row.strict_pass_rate for row in dashboard.overall}
    assert strict["stuff"] == 0.5  # a1 pass, a2 fail
    assert strict["stuff-oracle"] == 1.0
    assert strict["naive-rag"] == 0.0
    assert strict["agent"] == 1.0


def test_ragas_columns_present_only_for_rag_arms() -> None:
    dashboard = build_four_arm_dashboard(_columns())
    by_arm = {row.arm: row for row in dashboard.overall}
    # RAG arms carry a context-recall mean; stuffing arms carry None (RAG-only).
    assert by_arm["naive-rag"].context_recall == 0.5
    assert by_arm["agent"].context_recall == 0.9
    assert by_arm["stuff"].context_recall is None
    assert by_arm["stuff-oracle"].context_recall is None


def test_judge_point_score_is_reported_per_arm_when_supplied() -> None:
    cols = _columns()
    cols["stuff"] = ArmColumn(
        scores=_arm({"a1": True, "a2": False}),
        point_scores={"a1": 1.0, "a2": 0.0},
    )
    dashboard = build_four_arm_dashboard(cols)
    by_arm = {row.arm: row for row in dashboard.overall}
    assert by_arm["stuff"].point_score == 0.5


def test_slices_are_per_behavior_class_never_blended() -> None:
    items = {"a1": True, "a2": False}
    refuse = _score("r1", strict=True)
    refuse = ItemScore(
        item_id="r1",
        behavior_class="refuse-jurisdiction",
        behavior_match=True,
        cite_precision=1.0,
        cite_recall=1.0,
        retrieval_hit_rate=1.0,
        strict_pass=True,
    )
    cols = {
        arm: ArmColumn(scores=(*_arm(items), refuse))
        for arm in ("stuff", "stuff-oracle", "naive-rag", "agent")
    }
    dashboard = build_four_arm_dashboard(cols)
    slice_names = {s.slice for s in dashboard.slices}
    assert "answer" in slice_names
    assert "refuse-jurisdiction" in slice_names


def test_render_states_ragas_is_rag_only() -> None:
    text = render_four_arm_dashboard(build_four_arm_dashboard(_columns()), run_name="four-arm-v0")
    assert "four-arm-v0" in text
    # The table must SAY the RAGAS columns are RAG-only.
    assert "RAG-only" in text or "RAG arms only" in text
    # All four arm names appear.
    for arm in ("stuff", "stuff-oracle", "naive-rag", "agent"):
        assert arm in text
