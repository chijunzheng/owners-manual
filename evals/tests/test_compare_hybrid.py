"""Offline hybrid-vs-vector comparison wiring tests (#14 AC4).

Pins the measurement that produces the reported number: load the committed
fixture-chunk corpus, run each golden item through both offline arms, score the
pre-synthesis hit-rate with the SAME hierarchical metric the dashboard uses, and
build the comparison. Deterministic and network-free — the same numbers every
run, so the reported delta is reproducible.

Because the offline corpus carries only the designed fixtures (no Crown statute
text), the comparison runs over the golden items whose required cites land in
those fixtures (the void-clause items). That subset is stated honestly; the
full-corpus number is the live debug-endpoint run.
"""

from __future__ import annotations

from owners_manual_evals.compare_hybrid import (
    load_fixture_retrieval_corpus,
    run_live_comparison,
    run_offline_comparison,
)
from owners_manual_evals.golden_v0 import load_golden_v0_documents, load_golden_v0_set


def test_loads_the_committed_fixture_retrieval_corpus() -> None:
    corpus = load_fixture_retrieval_corpus()
    assert len(corpus) > 0
    keys = {doc.citable_path_key for doc in corpus}
    # the void-clause cites golden v0 references resolve in this corpus
    assert "fixture-lease|section:pets|clause:p-1" in keys
    # only fixture text is committed — never statute text (no Crown copyright)
    assert all(doc.document_id.startswith("fixture-") for doc in corpus)


def test_run_offline_comparison_over_golden_v0_fixture_cites() -> None:
    documents = load_golden_v0_documents()
    golden = load_golden_v0_set()
    corpus = load_fixture_retrieval_corpus()

    result = run_offline_comparison(
        golden=golden,
        documents=documents,
        corpus=corpus,
        top_k=8,
    )
    # The comparison is built over the fixture-cite items and is paired by item.
    assert result.comparison.overall.count > 0
    # Hit rates are valid fractions in both arms.
    assert 0.0 <= result.comparison.overall.vector_only_hit_rate <= 1.0
    assert 0.0 <= result.comparison.overall.hybrid_hit_rate <= 1.0
    # The selected items all carry at least one fixture-resolvable required cite.
    assert all(item.required_cites for item in result.items)


def test_run_offline_comparison_is_deterministic() -> None:
    documents = load_golden_v0_documents()
    golden = load_golden_v0_set()
    corpus = load_fixture_retrieval_corpus()
    a = run_offline_comparison(golden=golden, documents=documents, corpus=corpus, top_k=8)
    b = run_offline_comparison(golden=golden, documents=documents, corpus=corpus, top_k=8)
    assert a.comparison.overall == b.comparison.overall


def test_hybrid_never_loses_required_cites_the_dense_proxy_already_reached() -> None:
    # Fusion adds the BM25 stage; a cite the dense proxy reached at top-k can only
    # be reinforced, never dropped, when top_k is held. So hybrid hit-rate >=
    # vector-only hit-rate over this fixture corpus (reported honestly, but a
    # regression below this is a real bug).
    documents = load_golden_v0_documents()
    golden = load_golden_v0_set()
    corpus = load_fixture_retrieval_corpus()
    result = run_offline_comparison(golden=golden, documents=documents, corpus=corpus, top_k=25)
    overall = result.comparison.overall
    assert overall.hybrid_hit_rate >= overall.vector_only_hit_rate


def test_run_live_comparison_drives_both_modes_over_the_full_golden_set() -> None:
    # The live path runs EVERY answer/flag item (statute cites included) through
    # the service's debug endpoint in both modes. Here a fake retrieve stands in
    # for the HTTP debug client: hybrid reaches a required cite vector-only misses.
    documents = load_golden_v0_documents()
    golden = load_golden_v0_set()

    rta_key = "rta-2006|part:III|section:20|subsection:1"

    def fake_retrieve(*, question: str, mode: str) -> tuple[str, ...]:
        _ = question
        if mode == "hybrid":
            return (rta_key,)
        return ()  # vector-only misses it

    result = run_live_comparison(golden=golden, documents=documents, retrieve=fake_retrieve)
    # The repair item (required cite rta s.20(1)) is reached only under hybrid.
    overall = result.comparison.overall
    assert overall.hybrid_hit_rate >= overall.vector_only_hit_rate
    assert overall.count > 0
