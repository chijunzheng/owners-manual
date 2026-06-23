"""Run-plan tests (issue #23 AC1/AC2): the per-rung flag→env→build plan.

The live ladder is a MILESTONE activity (issue scope note): ~16 golden-set runs
over 3 corpus builds, the service stood up per arm. The agent's query-time
components are resolved SERVICE-SIDE from ``OWNERS_MANUAL_*`` env
(`agent-query-flags.ts`), so a rung's off-states must be expressed as the concrete
env + corpus build an operator stands the service up with. The run plan is that
bridge — and it is the testable, enforced form of "off-states documented and
enforced for all eight components" (AC2): every disabled query-time component maps
to its env flag turned OFF, and the rung names its required build.
"""

from __future__ import annotations

from owners_manual_evals.ablation_ladders import (
    DEFAULT_PINNED_BUILDS,
    LadderFlags,
    build_for_rung,
    ladder_run_plan,
    rung_env,
)


def test_full_system_env_turns_every_query_time_flag_on() -> None:
    env = rung_env(LadderFlags(enabled=frozenset(c for c in _all_keys())))
    # The agent query-time flags the service resolves (agent-query-flags.ts).
    assert env["OWNERS_MANUAL_XREF_EXPANSION"] == "1"
    assert env["OWNERS_MANUAL_DEFINITIONS_IN_PROMPT"] == "1"
    assert env["OWNERS_MANUAL_QUERY_REFORMULATION"] == "1"
    assert env["OWNERS_MANUAL_RERANK"] == "1"


def test_naive_floor_env_turns_every_query_time_flag_off() -> None:
    env = rung_env(LadderFlags(enabled=frozenset()))
    assert env["OWNERS_MANUAL_XREF_EXPANSION"] == "0"
    assert env["OWNERS_MANUAL_DEFINITIONS_IN_PROMPT"] == "0"
    assert env["OWNERS_MANUAL_QUERY_REFORMULATION"] == "0"
    assert env["OWNERS_MANUAL_RERANK"] == "0"


def test_graph_expansion_off_maps_to_its_env_flag_off() -> None:
    # Knock out graph-expansion only: its env flag is off, the others on.
    flags = LadderFlags(enabled=frozenset(set(_all_keys()) - {"graph-expansion"}))
    env = rung_env(flags)
    assert env["OWNERS_MANUAL_XREF_EXPANSION"] == "0"
    assert env["OWNERS_MANUAL_RERANK"] == "1"


def test_run_plan_covers_floor_plus_enforceable_buildup_and_knockout() -> None:
    # The LIVE plan emits runnable rungs ONLY for live-enforceable components
    # (Codex Finding 1): a rung knocking out an unsupported component would deploy
    # an identical full system, so it is never emitted. Five components are
    # live-enforceable, so the build-up ladder is floor + 5 and the knock-out is 5.
    plan = ladder_run_plan(pinned_builds=DEFAULT_PINNED_BUILDS)
    buildup = [step for step in plan if step.ladder == "build-up"]
    knockout = [step for step in plan if step.ladder == "knock-out"]
    assert len(buildup) == 6  # floor + 5 enforceable components
    assert len(knockout) == 5
    # Every step names a pinned build and carries its env.
    for step in plan:
        assert step.build in DEFAULT_PINNED_BUILDS
        assert "OWNERS_MANUAL_RERANK" in step.env


def test_no_ablation_rung_is_indistinguishable_from_the_full_system() -> None:
    # THE invariant (Codex Finding 1): every emitted live rung that CLAIMS to be an
    # ablation must differ from the full-system service config in build OR env — a
    # rung indistinguishable from the full system must never be emitted or scored
    # (it would deploy the full system and report a bogus ~0 delta). The build-up
    # ladder's terminal rung is the LEGITIMATE full-system anchor (it openly IS the
    # full system, the top of the ladder) and is the only rung allowed to equal it.
    from owners_manual_evals.ablation_ladders import full_system_flags, rung_env

    full_flags = full_system_flags()
    full_build = build_for_rung(full_flags, pinned_builds=DEFAULT_PINNED_BUILDS)
    full_env = rung_env(full_flags)
    plan = ladder_run_plan(pinned_builds=DEFAULT_PINNED_BUILDS)
    buildup = [step for step in plan if step.ladder == "build-up"]
    anchor = buildup[-1]  # the full-system top of the build-up ladder
    for step in plan:
        equals_full = step.build == full_build and step.env == full_env
        if step.rung_id == anchor.rung_id:
            assert equals_full, "the build-up ladder's top rung must be the full-system anchor"
        else:
            assert not equals_full, (
                f"ablation rung {step.rung_id!r} is indistinguishable from the full system"
            )


def test_unsupported_components_never_appear_as_runnable_rungs() -> None:
    plan = ladder_run_plan(pinned_builds=DEFAULT_PINNED_BUILDS)
    component_keys = {step.component_key for step in plan if step.component_key is not None}
    # hybrid-bm25, metadata-filters, critic have no service switch — they are
    # DEFERRED, never emitted as a runnable rung.
    assert "hybrid-bm25" not in component_keys
    assert "metadata-filters" not in component_keys
    assert "critic" not in component_keys


def test_run_plan_steps_have_stable_rung_ids() -> None:
    plan = ladder_run_plan(pinned_builds=DEFAULT_PINNED_BUILDS)
    ids = [step.rung_id for step in plan]
    # Rung ids are unique and stable (the Langfuse run-name suffix per rung).
    assert len(ids) == len(set(ids))
    assert "buildup-00-floor" in ids
    assert any(i.startswith("knockout-") and "planner" in i for i in ids)


def test_render_run_plan_emits_env_exports_and_builds() -> None:
    from owners_manual_evals.ablation_ladders import ladder_run_plan, render_run_plan

    plan = ladder_run_plan(pinned_builds=DEFAULT_PINNED_BUILDS)
    text = render_run_plan(plan, run_name="ablation-v1")
    # The runbook is copy-pasteable: it shows the env exports and the build per rung.
    assert "OWNERS_MANUAL_RERANK" in text
    assert "build-full" in text
    # It names the run + rung ids so an operator can run each arm and the tables
    # can read them back by name.
    assert "ablation-v1" in text
    assert "buildup-00-floor" in text
    # The milestone framing is stated (not a per-merge / CI job).
    assert "milestone" in text.lower()


def test_render_run_plan_surfaces_deferred_components_with_their_issue() -> None:
    from owners_manual_evals.ablation_ladders import ladder_run_plan, render_run_plan

    plan = ladder_run_plan(pinned_builds=DEFAULT_PINNED_BUILDS)
    text = render_run_plan(plan, run_name="ablation-v1")
    # The deferred components are surfaced (documented), not silently dropped.
    assert "deferred" in text.lower()
    assert "hybrid-bm25" in text
    assert "metadata-filters" in text
    assert "critic" in text
    assert "#41" in text
    assert "#14" in text


def _all_keys():
    from owners_manual_evals.ablation_ladders import COMPONENT_KEYS

    return COMPONENT_KEYS
