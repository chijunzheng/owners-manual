"""Order-permutation probe tests (issue #18).

The probe confirms the ``stuff`` arm is not a PREFIX-ORDER ARTIFACT: it runs the
arm over the golden items at several corpus-order permutations (seed 0 = canonical
baseline, plus probe seeds) and reports whether the strict-pass rate holds across
them. A result that swings with order would mean the arm is reading position, not
content. The arm runner is injected, so the probe is unit-tested offline.
"""

from __future__ import annotations

from owners_manual_evals.citable_path import CitablePath, CitablePathSegment
from owners_manual_evals.golden_item import AnswerPoint, GoldenItem, Provenance
from owners_manual_evals.order_probe import run_order_probe
from owners_manual_evals.stuff_client import StuffResult


def _item(item_id: str, *, strict_doc: bool = True) -> GoldenItem:
    cites = (
        (CitablePath(document_id="rta-2006", segments=(CitablePathSegment("section", "20"),)),)
        if strict_doc
        else ()
    )
    return GoldenItem(
        id=item_id,
        behavior_class="answer" if strict_doc else "refuse-jurisdiction",
        verified=True,
        question="q",
        answer_points=(AnswerPoint(id="p", text="t"),),
        required_cites=cites,
        provenance=Provenance(source="x", reference="y"),
    )


def _result(*, seed: int, cite: bool) -> StuffResult:
    keys = ("rta-2006|section:20",) if cite else ()
    cites = (
        (CitablePath(document_id="rta-2006", segments=(CitablePathSegment("section", "20"),)),)
        if cite
        else ()
    )
    return StuffResult(
        trace_id=f"seed{seed}",
        arm="stuff",
        behavior_class="answer" if cite else "refuse-jurisdiction",
        candidate_cites=cites,
        retrieved_path_keys=keys,
        stuffed_source_count=5,
        usage={},
        cost_usd=0.0,
        order_seed=seed,
        corpus_build_hash="f" * 64,
        pipeline_config_hash="e" * 64,
        latency_ms={"total": 1.0},
    )


def _document_trees():
    from owners_manual_evals.document_tree import parse_document_tree

    return (
        parse_document_tree(
            {
                "kind": "document",
                "documentId": "rta-2006",
                "label": "RTA",
                "children": [{"kind": "section", "label": "20", "children": []}],
            }
        ),
    )


class _StableStuffClient:
    """Returns the SAME (correct) answer regardless of order seed — not an artifact."""

    def __init__(self) -> None:
        self.seeds_seen: list[int] = []

    def stuff(self, **kwargs: object) -> StuffResult:
        seed = int(kwargs.get("order_seed") or 0)
        self.seeds_seen.append(seed)
        return _result(seed=seed, cite=True)


def test_probe_runs_each_seed_over_every_item() -> None:
    client = _StableStuffClient()
    documents = _document_trees()
    report = run_order_probe(
        items=(_item("a1"), _item("a2")),
        documents=documents,
        client=client,
        run_name="probe",
        seeds=(0, 1, 2),
    )
    # 3 seeds × 2 items.
    assert sorted(client.seeds_seen) == [0, 0, 1, 1, 2, 2]
    assert {r.seed for r in report.per_seed} == {0, 1, 2}


def test_probe_reports_stable_strict_pass_for_an_order_insensitive_arm() -> None:
    client = _StableStuffClient()
    report = run_order_probe(
        items=(_item("a1"), _item("a2")),
        documents=_document_trees(),
        client=client,
        run_name="probe",
        seeds=(0, 1, 2),
    )
    # Every seed yields the same strict-pass rate → not a prefix-order artifact.
    assert all(r.strict_pass_rate == 1.0 for r in report.per_seed)
    assert report.is_order_sensitive is False
    assert report.strict_pass_spread == 0.0


class _OrderSensitiveClient:
    """Passes only at the canonical seed — a prefix-order artifact."""

    def stuff(self, **kwargs: object) -> StuffResult:
        seed = int(kwargs.get("order_seed") or 0)
        return _result(seed=seed, cite=(seed == 0))


def test_probe_flags_an_order_sensitive_arm() -> None:
    client = _OrderSensitiveClient()
    report = run_order_probe(
        items=(_item("a1"),),
        documents=_document_trees(),
        client=client,
        run_name="probe",
        seeds=(0, 1),
    )
    rates = {r.seed: r.strict_pass_rate for r in report.per_seed}
    assert rates[0] == 1.0
    assert rates[1] == 0.0
    assert report.is_order_sensitive is True
    assert report.strict_pass_spread == 1.0


def test_probe_render_names_the_seeds_and_the_verdict() -> None:
    client = _StableStuffClient()
    report = run_order_probe(
        items=(_item("a1"),),
        documents=_document_trees(),
        client=client,
        run_name="probe-v0",
        seeds=(0, 7),
    )
    text = report.render()
    assert "probe-v0" in text
    assert "seed" in text.lower()
    # States the not-an-artifact conclusion in plain words.
    assert "artifact" in text.lower()
