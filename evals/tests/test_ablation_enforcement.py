"""Enforcement-classification tests (issue #23 AC2, Codex Finding 1).

The OFFLINE component model is the full eight-component framework #23 delivers
(driven by an injected fake ``run_rung``). But only a SUBSET of those off-states
have a real switch on the DEPLOYED service: two index-time components are enforced
by the corpus build, two query-time components by a named ``OWNERS_MANUAL_*`` env
flag, and the rest have NO off-switch yet (the planner only via reformulation; the
critic is wired unconditionally; hybrid-BM25 and metadata-filters have no
query-time knob). The live runbook + the Langfuse-derived README tables must be
HONEST about that — they may only emit rungs that the service can actually stand
up as a DISTINCT configuration from the full system, and the unsupported
components must be surfaced as explicitly DEFERRED, never silently faked.

These tests pin that contract:
  * the enforcement classification is EXHAUSTIVE (all eight classified, no
    component unhandled);
  * the live-enforceable set is exactly the corpus-build + named-env components;
  * the unsupported components are surfaced with their blocking issue.
"""

from __future__ import annotations

from owners_manual_evals.ablation_ladders import (
    COMPONENT_KEYS,
    EIGHT_COMPONENTS,
    Enforcement,
    component_enforcement,
    deferred_components,
    live_enforceable_components,
)


def test_every_component_has_an_enforcement_classification() -> None:
    # Exhaustive: each of the eight is classified, and every classification is a
    # member of the closed Enforcement set (no component left unhandled).
    classified = {c.key: component_enforcement(c.key) for c in EIGHT_COMPONENTS}
    assert set(classified) == set(COMPONENT_KEYS)
    assert all(isinstance(value, Enforcement) for value in classified.values())


def test_index_time_components_are_enforced_by_corpus_build() -> None:
    assert component_enforcement("hierarchy-chunks") is Enforcement.CORPUS_BUILD
    assert component_enforcement("contextual-enrichment") is Enforcement.CORPUS_BUILD


def test_graph_expansion_and_rerank_are_enforced_by_a_named_env_flag() -> None:
    assert component_enforcement("graph-expansion") is Enforcement.QUERY_ENV
    assert component_enforcement("authority-rerank") is Enforcement.QUERY_ENV


def test_planner_is_enforced_by_a_named_env_flag() -> None:
    # The planner is live-enforceable, but only via QUERY_REFORMULATION — its
    # honest off-state is "no bounded reformulation", NOT "no routing".
    assert component_enforcement("planner") is Enforcement.QUERY_ENV


def test_unsupported_components_have_no_service_switch_yet() -> None:
    # hybrid-bm25, metadata-filters, critic: knocking them out changes neither the
    # corpus build nor the env, so the service would deploy an identical full
    # system. They are UNSUPPORTED until a switch exists.
    assert component_enforcement("hybrid-bm25") is Enforcement.UNSUPPORTED
    assert component_enforcement("metadata-filters") is Enforcement.UNSUPPORTED
    assert component_enforcement("critic") is Enforcement.UNSUPPORTED


def test_live_enforceable_is_exactly_the_build_and_env_components() -> None:
    enforceable = set(live_enforceable_components())
    assert enforceable == {
        "hierarchy-chunks",
        "contextual-enrichment",
        "graph-expansion",
        "authority-rerank",
        "planner",
    }


def test_deferred_components_are_surfaced_with_a_blocking_issue() -> None:
    deferred = deferred_components()
    # The deferred set is exactly the unsupported components — never silently
    # dropped.
    assert {d.component_key for d in deferred} == {
        "hybrid-bm25",
        "metadata-filters",
        "critic",
    }
    # Each carries a non-empty tracking note naming the blocking issue, so the
    # runbook/README can state WHY it is deferred.
    for entry in deferred:
        assert entry.note.strip() != ""
    by_key = {d.component_key: d for d in deferred}
    assert "#41" in by_key["metadata-filters"].note
    assert "#14" in by_key["hybrid-bm25"].note
    assert "critic" in by_key["critic"].note.lower()


def test_enforceable_and_deferred_partition_the_eight_exactly_once() -> None:
    enforceable = set(live_enforceable_components())
    deferred = {d.component_key for d in deferred_components()}
    assert enforceable | deferred == set(COMPONENT_KEYS)
    assert enforceable.isdisjoint(deferred)
