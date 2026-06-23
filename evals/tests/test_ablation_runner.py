"""Two-ladder runner tests (issue #23 AC1): both ladders, one command, pinned build.

AC1 — "Both ladders run from one command against a pinned build set." The runner
is pure orchestration: an injected per-rung runner (so it is unit-tested offline
against a fake, like every live seam here) drives the cumulative build-up ladder
and the leave-one-out knock-out ladder over the eight components, paired by item,
against a PINNED set of corpus builds. Each rung's strict-pass rate and its
paired-by-item delta (with a seeded bootstrap CI) are recorded.

The pin is enforced: a rung whose required corpus build is absent from the pinned
build set is a hard error — the ladder numbers are only comparable when every arm
ran against a known build (CONTEXT.md, "Corpus build").
"""

from __future__ import annotations

from collections.abc import Sequence

from owners_manual_evals.ablation_ladders import (
    COMPONENT_KEYS,
    EIGHT_COMPONENTS,
    LadderFlags,
    build_for_rung,
    run_ablation_ladders,
)
from owners_manual_evals.metrics import ItemScore

# Three pinned corpus builds (CONTEXT.md, README "~16 golden-set runs over 3
# corpus builds"): the full build, plus one per index-time off-state shape.
PINNED_BUILDS = ("build-full", "build-naive-chunks", "build-no-enrichment")


def _scores(*, n: int, pass_first: int) -> tuple[ItemScore, ...]:
    return tuple(
        ItemScore(
            item_id=f"i{i}",
            behavior_class="answer",
            behavior_match=True,
            cite_precision=1.0,
            cite_recall=1.0 if i < pass_first else 0.0,
            retrieval_hit_rate=1.0,
            strict_pass=i < pass_first,
        )
        for i in range(n)
    )


def _monotone_runner(flags: LadderFlags, build: str) -> tuple[ItemScore, ...]:
    """A fake per-rung runner whose pass count grows with how many components are
    on — so the build-up ladder climbs and the knock-outs dip, deterministically."""
    _ = build
    return _scores(n=10, pass_first=2 + len(flags.enabled_components))


def test_one_call_runs_both_ladders() -> None:
    result = run_ablation_ladders(
        run_rung=_monotone_runner,
        pinned_builds=PINNED_BUILDS,
        seed=1,
        iterations=200,
    )
    # The build-up ladder has one rung per component PLUS the naive-rag floor.
    assert len(result.buildup) == len(EIGHT_COMPONENTS) + 1
    # The knock-out ladder has exactly one rung per component (leave-one-out).
    assert len(result.knockout) == len(EIGHT_COMPONENTS)


def test_buildup_records_each_components_arrival_delta() -> None:
    result = run_ablation_ladders(
        run_rung=_monotone_runner, pinned_builds=PINNED_BUILDS, seed=1, iterations=200
    )
    # Build-up rung k>0 attributes the delta to the k-th component added; its key
    # is the k-th in dependency order, and (with the monotone fake) the delta is
    # +0.1 strict pass (one extra item passes per added component out of 10).
    for index, rung in enumerate(result.buildup):
        if index == 0:
            assert rung.component_key is None  # the naive-rag floor rung
        else:
            assert rung.component_key == COMPONENT_KEYS[index - 1]
            assert abs(rung.delta.point_estimate - 0.1) < 1e-9


def test_knockout_records_each_components_removal_delta() -> None:
    result = run_ablation_ladders(
        run_rung=_monotone_runner, pinned_builds=PINNED_BUILDS, seed=1, iterations=200
    )
    keys = {rung.component_key for rung in result.knockout}
    assert keys == set(COMPONENT_KEYS)
    # Removing any one component from the full system drops one item (delta is the
    # knock-out arm minus the full system → negative with the monotone fake).
    for rung in result.knockout:
        assert rung.delta.point_estimate < 0.0


def test_runner_pins_every_rung_to_a_build_in_the_pinned_set() -> None:
    # A pinned set missing an index-time build is a hard error: the build-up ladder
    # needs the naive-chunks and no-enrichment builds for its index-time off-states.
    incomplete = ("build-full",)
    try:
        run_ablation_ladders(
            run_rung=_monotone_runner, pinned_builds=incomplete, seed=1, iterations=50
        )
    except ValueError as error:
        assert "build" in str(error).lower()
    else:  # pragma: no cover
        raise AssertionError("expected a ValueError when a required build is unpinned")


def test_runner_passes_the_correct_build_to_each_rung() -> None:
    seen: dict[str, str] = {}

    def recording_runner(flags: LadderFlags, build: str) -> tuple[ItemScore, ...]:
        # Record the build chosen for the full system and for an index-time
        # knock-out so we can assert the rung→build routing.
        key = ",".join(flags.enabled_components) or "<naive>"
        seen[key] = build
        return _scores(n=6, pass_first=1 + len(flags.enabled_components))

    run_ablation_ladders(
        run_rung=recording_runner, pinned_builds=PINNED_BUILDS, seed=1, iterations=50
    )
    # The full system runs on the full build.
    full_key = ",".join(COMPONENT_KEYS)
    assert seen[full_key] == "build-full"
    # The naive-rag floor needs a NON-full build (its chunks/enrichment are off).
    assert seen["<naive>"] != "build-full"


def test_build_for_rung_reuses_full_build_for_query_time_only_rungs() -> None:
    # A rung that only disables query-time components reuses the full build — the
    # matrix leans on free query-time flips (CONTEXT.md), not a rebuild per rung.
    full_minus_critic = LadderFlags(enabled=frozenset(set(COMPONENT_KEYS) - {"critic"}))
    assert build_for_rung(full_minus_critic, pinned_builds=PINNED_BUILDS) == "build-full"


def test_runner_is_seeded_and_reproducible() -> None:
    def runner(flags: LadderFlags, build: str) -> tuple[ItemScore, ...]:
        _ = build
        return _scores(n=8, pass_first=1 + len(flags.enabled_components))

    a = run_ablation_ladders(run_rung=runner, pinned_builds=PINNED_BUILDS, seed=7, iterations=300)
    b = run_ablation_ladders(run_rung=runner, pinned_builds=PINNED_BUILDS, seed=7, iterations=300)
    a_bounds = [(r.delta.low, r.delta.high) for r in a.buildup + a.knockout]
    b_bounds = [(r.delta.low, r.delta.high) for r in b.buildup + b.knockout]
    assert a_bounds == b_bounds


def test_runner_rejects_mismatched_item_sets_across_rungs() -> None:
    # Deltas are paired by item; a rung that runs a different item set than its
    # comparison anchor is meaningless and must raise rather than silently mispair.
    def drifting_runner(flags: Sequence, build: str) -> tuple[ItemScore, ...]:
        _ = build
        n = len(flags.enabled_components)
        # Shift the item ids once any component is on → the floor and rung 1 differ.
        offset = 0 if n == 0 else 100
        return tuple(
            ItemScore(
                item_id=f"i{offset + i}",
                behavior_class="answer",
                behavior_match=True,
                cite_precision=1.0,
                cite_recall=1.0,
                retrieval_hit_rate=1.0,
                strict_pass=True,
            )
            for i in range(5)
        )

    try:
        run_ablation_ladders(
            run_rung=drifting_runner, pinned_builds=PINNED_BUILDS, seed=1, iterations=50
        )
    except ValueError as error:
        assert "paired" in str(error).lower() or "item" in str(error).lower()
    else:  # pragma: no cover
        raise AssertionError("expected a ValueError for mismatched item sets across rungs")
