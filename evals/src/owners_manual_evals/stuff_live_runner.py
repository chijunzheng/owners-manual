"""Live wiring for the stuffing arms (issue #18): trace propagation + the client.

The stuff analog of :mod:`agent_live_runner`, kept SEPARATE so the frozen
naive-rag and agent paths are never reshaped. For each item it derives a
deterministic, correlatable trace id with an ARM-SPECIFIC seed (so the same item's
four arm runs are four distinct traces), drives the ``/stuff`` or ``/stuff-oracle``
route with trace-id propagation, and returns the parsed outcome the runner scores
exactly like the other arms — carrying the honest cost-per-question so the
dashboard's cost column is real.

The ``stuff-oracle`` arm feeds the route the corpora derived from the item's
required cites (:func:`oracle_corpora_for_item`); a refusal item with no cites has
nothing to route on, so it falls back to the full corpus (every corpus) — for that
item the oracle arm IS the stuff arm.

Live by design; the unit suite exercises the wiring against a fake client.
"""

from __future__ import annotations

import hashlib
from typing import Any, Protocol

from .golden_item import GoldenItem
from .oracle import CORPORA, oracle_corpora_for_item
from .run_naive_rag import AnswerFn, ItemOutcome
from .stuff_client import StuffResult

#: Per-arm seed suffixes so an item's four arm runs land on distinct traces.
_STUFF_SEED_SUFFIX = "stuff"
_STUFF_ORACLE_SEED_SUFFIX = "stuff-oracle"


class _StuffClientLike(Protocol):
    def stuff(self, **kwargs: Any) -> StuffResult: ...
    def stuff_oracle(self, **kwargs: Any) -> StuffResult: ...


def _trace_id(run_name: str, suffix: str, item_id: str) -> str:
    return hashlib.sha256(f"{run_name}:{suffix}:{item_id}".encode()).hexdigest()[:32]


def _outcome(item: GoldenItem, result: StuffResult, trace_id: str) -> ItemOutcome:
    """Map a :class:`StuffResult` onto the runner's :class:`ItemOutcome` — the
    honest cost flows through so the dashboard reports it."""
    return ItemOutcome(
        item_id=item.id,
        observed_behavior=result.behavior_class,
        candidate_cites=result.candidate_cites,
        retrieved_path_keys=result.retrieved_path_keys,
        latency_ms=dict(result.latency_ms),
        cost_usd=result.cost_usd,
        trace_id=trace_id,
        answer_text=result.answer_text,
    )


def build_stuff_answer(*, client: _StuffClientLike, run_name: str) -> AnswerFn:
    """Build the ``stuff`` arm's per-item answer function (entire corpus)."""

    def answer(item: GoldenItem) -> ItemOutcome:
        trace_id = _trace_id(run_name, _STUFF_SEED_SUFFIX, item.id)
        result = client.stuff(question=item.question, item_id=item.id, trace_id=trace_id)
        return _outcome(item, result, trace_id)

    return answer


def build_stuff_oracle_answer(*, client: _StuffClientLike, run_name: str) -> AnswerFn:
    """Build the ``stuff-oracle`` arm's per-item answer function (routed corpus).

    Routes to the corpora of the item's required cites; a refusal item with no
    cites routes to every corpus (it is `stuff` for that item)."""

    def answer(item: GoldenItem) -> ItemOutcome:
        trace_id = _trace_id(run_name, _STUFF_ORACLE_SEED_SUFFIX, item.id)
        routed = oracle_corpora_for_item(item)
        corpora = routed if routed else CORPORA
        result = client.stuff_oracle(
            question=item.question,
            item_id=item.id,
            corpora=corpora,
            trace_id=trace_id,
        )
        return _outcome(item, result, trace_id)

    return answer


__all__ = ["build_stuff_answer", "build_stuff_oracle_answer"]
