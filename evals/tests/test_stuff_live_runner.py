"""Stuffing-arm live-runner wiring tests (issue #18).

The stuff analog of :mod:`agent_live_runner`. For each item it derives a
deterministic, correlatable trace id (distinct per arm), drives the ``/stuff`` or
``/stuff-oracle`` route, and returns the parsed outcome the runner scores exactly
like the other arms. The oracle arm feeds the route the corpora derived from the
item's required cites; a refusal item with no cites falls back to the full corpus.

Live by design; these tests exercise the offline wiring with a fake client.
"""

from __future__ import annotations

from owners_manual_evals.citable_path import CitablePath, CitablePathSegment
from owners_manual_evals.golden_item import AnswerPoint, GoldenItem, Provenance
from owners_manual_evals.stuff_client import StuffResult
from owners_manual_evals.stuff_live_runner import (
    build_stuff_answer,
    build_stuff_oracle_answer,
)


def _item(item_id: str, document_ids: list[str], *, behavior: str = "answer") -> GoldenItem:
    return GoldenItem(
        id=item_id,
        behavior_class=behavior,  # type: ignore[arg-type]
        verified=True,
        question="q",
        answer_points=(AnswerPoint(id="p", text="t"),),
        required_cites=tuple(
            CitablePath(document_id=d, segments=(CitablePathSegment("section", "1"),))
            for d in document_ids
        ),
        provenance=Provenance(source="x", reference="y"),
    )


class _FakeStuffClient:
    """Records the calls each arm makes and returns a canned result."""

    def __init__(self) -> None:
        self.stuff_calls: list[dict] = []
        self.oracle_calls: list[dict] = []

    def stuff(self, **kwargs: object) -> StuffResult:
        self.stuff_calls.append(dict(kwargs))
        return _result("stuff")

    def stuff_oracle(self, **kwargs: object) -> StuffResult:
        self.oracle_calls.append(dict(kwargs))
        return _result("stuff-oracle")


def _result(arm: str) -> StuffResult:
    return StuffResult(
        trace_id="a" * 32,
        arm=arm,
        behavior_class="answer",
        candidate_cites=(),
        retrieved_path_keys=(),
        stuffed_source_count=5,
        usage={"promptTokens": 1000.0, "cachedPromptTokens": 900.0, "completionTokens": 50.0},
        cost_usd=0.01,
        order_seed=0,
        corpus_build_hash="f" * 64,
        pipeline_config_hash="e" * 64,
        latency_ms={"total": 800.0},
    )


def test_stuff_answer_drives_the_stuff_route_and_carries_cost() -> None:
    client = _FakeStuffClient()
    answer = build_stuff_answer(client=client, run_name="four-arm-v0")
    outcome = answer(_item("a1", ["rta-2006"]))
    assert len(client.stuff_calls) == 1
    assert outcome.cost_usd == 0.01
    assert outcome.observed_behavior == "answer"


def test_stuff_oracle_routes_to_the_items_required_cite_corpora() -> None:
    client = _FakeStuffClient()
    answer = build_stuff_oracle_answer(client=client, run_name="four-arm-v0")
    answer(_item("a1", ["rta-2006", "fixture-declaration"], behavior="flag-void-clause"))
    assert client.oracle_calls[0]["corpora"] == ("tenancy", "governing")


def test_stuff_oracle_falls_back_to_full_corpus_for_a_refusal_item() -> None:
    client = _FakeStuffClient()
    answer = build_stuff_oracle_answer(client=client, run_name="four-arm-v0")
    answer(_item("r1", [], behavior="refuse-jurisdiction"))
    # No cites to route on → route to every corpus (it is `stuff` for this item).
    assert set(client.oracle_calls[0]["corpora"]) == {
        "tenancy",
        "insurance",
        "governing",
        "selling",
    }


def test_each_arm_uses_a_distinct_trace_seed_for_the_same_item() -> None:
    client = _FakeStuffClient()
    stuff = build_stuff_answer(client=client, run_name="four-arm-v0")
    oracle = build_stuff_oracle_answer(client=client, run_name="four-arm-v0")
    stuff(_item("a1", ["rta-2006"]))
    oracle(_item("a1", ["rta-2006"]))
    stuff_trace = client.stuff_calls[0]["trace_id"]
    oracle_trace = client.oracle_calls[0]["trace_id"]
    assert stuff_trace != oracle_trace  # distinct, correlatable traces per arm
