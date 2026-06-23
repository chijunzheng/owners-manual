"""Eight-component definition + off-state enforcement tests (issue #23 AC2).

CONTEXT.md ("Ablation ladder"): the two ladders decompose the naive-rag→agent gap
"over eight components in dependency order ... Every off-state has a defined
fallback." README ("Component attribution") pins the eight and three of the
fallbacks (planner-off = single hop across all corpora; critic-off = unverified
synthesis; rerank-off = raw similarity order).

These tests are the contract for AC2: there are exactly eight components, in the
README's dependency order, each carries a documented non-empty off-state, and the
ladder rung → flag-configuration mapping actually APPLIES each off-state (a rung
that should disable a component must not leave it on).
"""

from __future__ import annotations

from owners_manual_evals.ablation_ladders import (
    EIGHT_COMPONENTS,
    AblationComponent,
    flags_for_buildup_rung,
    flags_for_knockout_rung,
    full_system_flags,
    naive_rag_flags,
)


def test_there_are_exactly_eight_components_in_dependency_order() -> None:
    keys = tuple(c.key for c in EIGHT_COMPONENTS)
    assert keys == (
        "hierarchy-chunks",
        "contextual-enrichment",
        "hybrid-bm25",
        "metadata-filters",
        "graph-expansion",
        "authority-rerank",
        "planner",
        "critic",
    )


def test_every_component_documents_a_non_empty_off_state() -> None:
    for component in EIGHT_COMPONENTS:
        assert isinstance(component, AblationComponent)
        assert component.off_state.strip() != ""
        assert component.label.strip() != ""


def test_the_readme_pinned_off_states_match_the_readme() -> None:
    by_key = {c.key: c for c in EIGHT_COMPONENTS}
    # README ("Component attribution"): the named fallbacks. The planner off-state
    # is the HONEST one (Codex Finding 1): OWNERS_MANUAL_QUERY_REFORMULATION gates
    # only the bounded reformulation — corpus routing runs unconditionally — so the
    # off-state is "no bounded reformulation (single retrieval pass)", NOT the old
    # overclaimed "single hop, no routing".
    assert "no bounded reformulation" in by_key["planner"].off_state.lower()
    assert "single retrieval pass" in by_key["planner"].off_state.lower()
    assert "unverified" in by_key["critic"].off_state.lower()
    assert "raw similarity" in by_key["authority-rerank"].off_state.lower()


def test_buildup_rung_zero_is_the_naive_rag_floor() -> None:
    # The build-up ladder starts from naive-rag (no component on) and adds one
    # component per rung in dependency order. Rung 0 = the floor itself.
    assert flags_for_buildup_rung(0) == naive_rag_flags()


def test_buildup_final_rung_is_the_full_system() -> None:
    # Adding all eight components reconstructs the full agent system.
    assert flags_for_buildup_rung(len(EIGHT_COMPONENTS)) == full_system_flags()


def test_buildup_rung_enables_exactly_the_first_k_components() -> None:
    # Rung k has the first k components ON and the rest OFF (cumulative build-up).
    flags = flags_for_buildup_rung(3)
    on = flags.enabled_components
    assert on == ("hierarchy-chunks", "contextual-enrichment", "hybrid-bm25")
    # The complement is the set ablated to its off-state (the AC2 contract) — every
    # component is either enabled or degraded, partitioning the eight exactly once.
    assert set(on) | set(flags.disabled_components) == set(c.key for c in EIGHT_COMPONENTS)
    assert set(on).isdisjoint(flags.disabled_components)
    assert flags.disabled_components == (
        "metadata-filters",
        "graph-expansion",
        "authority-rerank",
        "planner",
        "critic",
    )


def test_knockout_rung_disables_exactly_one_component_from_full() -> None:
    # Leave-one-out: the full system with exactly ONE component removed.
    flags = flags_for_knockout_rung("planner")
    on = set(flags.enabled_components)
    full = set(full_system_flags().enabled_components)
    assert full - on == {"planner"}


def test_knockout_rejects_an_unknown_component() -> None:
    try:
        flags_for_knockout_rung("nonexistent-component")
    except ValueError as error:
        assert "nonexistent-component" in str(error)
    else:  # pragma: no cover
        raise AssertionError("expected a ValueError for an unknown component key")


def test_buildup_rung_index_is_bounds_checked() -> None:
    for bad in (-1, len(EIGHT_COMPONENTS) + 1):
        try:
            flags_for_buildup_rung(bad)
        except ValueError:
            pass
        else:  # pragma: no cover
            raise AssertionError(f"expected a ValueError for out-of-range rung {bad}")
