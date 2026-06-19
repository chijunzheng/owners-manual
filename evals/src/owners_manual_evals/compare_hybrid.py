"""The offline hybrid-vs-vector-only comparison measurement (#14 AC4).

This is the one command that produces the REPORTED, reproducible hit-rate delta
in CI: it loads the committed fixture-chunk corpus, runs each golden-v0 item
through the two offline arms (:mod:`offline_retrieval`), scores the pre-synthesis
required-cite hit-rate with the SAME hierarchical metric the dashboard uses
(:func:`score_item`), and builds + renders the comparison (:mod:`arm_comparison`).

The offline corpus carries only the designed fixtures (no Crown statute text),
so the comparison runs over the golden items whose required cites resolve in
those fixtures — the void-clause items. That subset is stated honestly in the
render. The FULL-corpus number (statute cites included) comes from the live
``/retrieve/debug`` endpoint, driven the same way; this offline run is the
deterministic, no-cluster measurement that lands in CI.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace

from .arm_comparison import HitRateComparison, build_hit_rate_comparison, render_hit_rate_comparison
from .citable_path import CitablePath
from .cite_matcher import resolves_to_node
from .document_tree import DocumentTree
from .golden_fixtures import resolve_fixtures_dir
from .golden_item import GoldenItem
from .golden_loader import GoldenSet, eval_run_items
from .live_corpus import is_live_serviceable
from .metrics import score_item
from .offline_retrieval import RetrievalDoc, retrieve_hybrid, retrieve_vector_only

#: A retrieval callable: take a question and a mode, return retrieved path keys.
#: The live impl wraps the ``/retrieve/debug`` client; a fake stands in for tests.
RetrieveFn = Callable[..., tuple[str, ...]]

#: Filename of the committed offline retrieval corpus (designed fixtures only).
_RETRIEVAL_CORPUS_FILENAME = "fixture-chunks.json"


def load_fixture_retrieval_corpus() -> tuple[RetrievalDoc, ...]:
    """Load the committed fixture-chunk corpus the offline comparison searches."""
    path = resolve_fixtures_dir().parent / "retrieval" / _RETRIEVAL_CORPUS_FILENAME
    rows = json.loads(path.read_text(encoding="utf-8"))
    return tuple(
        RetrievalDoc(
            document_id=row["documentId"],
            citable_path_key=row["citablePathKey"],
            text=row["text"],
        )
        for row in rows
    )


@dataclass(frozen=True, slots=True)
class OfflineComparisonResult:
    """The comparison plus the golden items it was measured over."""

    comparison: HitRateComparison
    items: tuple[GoldenItem, ...]


def _corpus_resolvable_cites(
    item: GoldenItem, corpus_doc_ids: frozenset[str]
) -> tuple[CitablePath, ...]:
    """An item's required cites the offline corpus could actually retrieve — those
    on a document the corpus carries.

    The offline corpus holds only the designed fixtures (no Crown statute text), so
    a statute cite can never be retrieved offline. Left in the hit-rate denominator
    it is a PERMANENTLY-unreachable requirement, not a retrieval miss: it deflates
    BOTH arms equally and halves the measured delta. Dropping it makes the offline
    number a clean designed-fixture-cite hit rate (the ``--live`` run measures the
    full cite set, statute cites included)."""
    return tuple(cite for cite in item.required_cites if cite.document_id in corpus_doc_ids)


def _items_with_corpus_resolvable_cites(
    golden: GoldenSet,
    documents: Sequence[DocumentTree],
    corpus: Sequence[RetrievalDoc],
) -> tuple[GoldenItem, ...]:
    """Verified golden items at least one of whose required cites lands on a
    document the offline corpus actually carries (the fixtures). Items whose
    cites are all statute-only are out of scope for the offline run."""
    corpus_doc_ids = {doc.document_id for doc in corpus}
    selected: list[GoldenItem] = []
    for item in eval_run_items(golden):
        if any(
            cite.document_id in corpus_doc_ids and resolves_to_node(cite, documents)
            for cite in item.required_cites
        ):
            selected.append(item)
    return tuple(selected)


def run_offline_comparison(
    *,
    golden: GoldenSet,
    documents: Sequence[DocumentTree],
    corpus: Sequence[RetrievalDoc],
    top_k: int,
) -> OfflineComparisonResult:
    """Run golden v0 through both offline arms and build the hit-rate comparison.

    Only the items with a fixture-resolvable required cite are measured (the
    offline corpus has no statute text); both arms see the identical corpus, so
    the delta isolates the BM25+RRF mechanism.
    """
    items = _items_with_corpus_resolvable_cites(golden, documents, corpus)
    corpus_doc_ids = frozenset(doc.document_id for doc in corpus)

    vector_scores = []
    hybrid_scores = []
    for item in items:
        # Score only the cites the offline corpus could retrieve: a statute cite the
        # fixtures don't carry is a permanently-unreachable requirement, not a
        # retrieval miss, so it must not sit in the hit-rate denominator (#14 gate).
        scored_item = replace(item, required_cites=_corpus_resolvable_cites(item, corpus_doc_ids))
        vector = retrieve_vector_only(query=item.question, corpus=corpus, top_k=top_k)
        hybrid = retrieve_hybrid(query=item.question, corpus=corpus, top_k=top_k)
        vector_scores.append(
            score_item(
                scored_item,
                observed_behavior=item.behavior_class,
                candidate_cites=(),
                retrieved_path_keys=tuple(c.citable_path_key for c in vector),
                documents=documents,
            )
        )
        hybrid_scores.append(
            score_item(
                scored_item,
                observed_behavior=item.behavior_class,
                candidate_cites=(),
                retrieved_path_keys=tuple(c.citable_path_key for c in hybrid),
                documents=documents,
            )
        )

    comparison = build_hit_rate_comparison(vector_only=vector_scores, hybrid=hybrid_scores)
    return OfflineComparisonResult(comparison=comparison, items=items)


def run_live_comparison(
    *,
    golden: GoldenSet,
    documents: Sequence[DocumentTree],
    retrieve: RetrieveFn,
) -> OfflineComparisonResult:
    """Run the FULL golden set (statute cites included) through both modes of the
    live retrieval debug endpoint and build the hit-rate comparison.

    ``retrieve(question=…, mode=…)`` returns the retrieved path keys; the live
    impl wraps the ``/retrieve/debug`` client (one call per mode per item), so
    vector-only and hybrid run over the SAME hierarchy chunks and the delta
    isolates the BM25+RRF mechanism. Items with required cites are measured (a
    refusal contributes a vacuous 1.0 to both arms and never moves the delta).
    Only LIVE-SERVICEABLE items are measured — an item whose cites the live index
    does not hold (insurance before the corpus expansion) is skipped rather than
    scored as a false miss against a service with no chunks for it.
    """
    items = tuple(
        item for item in eval_run_items(golden) if item.required_cites and is_live_serviceable(item)
    )

    vector_scores = []
    hybrid_scores = []
    for item in items:
        vector_keys = retrieve(question=item.question, mode="vector")
        hybrid_keys = retrieve(question=item.question, mode="hybrid")
        vector_scores.append(
            score_item(
                item,
                observed_behavior=item.behavior_class,
                candidate_cites=(),
                retrieved_path_keys=vector_keys,
                documents=documents,
            )
        )
        hybrid_scores.append(
            score_item(
                item,
                observed_behavior=item.behavior_class,
                candidate_cites=(),
                retrieved_path_keys=hybrid_keys,
                documents=documents,
            )
        )

    comparison = build_hit_rate_comparison(vector_only=vector_scores, hybrid=hybrid_scores)
    return OfflineComparisonResult(comparison=comparison, items=items)


def _build_live_retrieve(service_url: str, top_k: int) -> RetrieveFn:
    """Wrap the ``/retrieve/debug`` client as a ``RetrieveFn`` over both modes."""
    from .debug_client import RetrieveDebugClient  # noqa: PLC0415

    client = RetrieveDebugClient(base_url=service_url)

    def retrieve(*, question: str, mode: str) -> tuple[str, ...]:
        return client.retrieve(question=question, mode=mode, top_k=top_k).retrieved_path_keys

    return retrieve


def main(argv: Sequence[str] | None = None) -> int:
    """Print the hybrid-vs-vector-only hit-rate comparison over golden v0.

    Offline by default (deterministic, no cluster): measures the fixture-cite
    subset over the committed corpus. With ``--live <url>`` it drives the running
    service's ``/retrieve/debug`` endpoint in both modes over the FULL golden set
    (statute cites included).
    """
    import argparse  # noqa: PLC0415

    from .golden_v0 import load_golden_v0_documents, load_golden_v0_set  # noqa: PLC0415

    parser = argparse.ArgumentParser(
        prog="compare-hybrid",
        description="Report the required-cite hit rate: hybrid vs vector-only, over golden v0.",
    )
    parser.add_argument(
        "--live",
        metavar="SERVICE_URL",
        default=None,
        help="Drive the running service's /retrieve/debug endpoint over the FULL golden set "
        "(default: offline over the committed fixture corpus).",
    )
    parser.add_argument("--top-k", type=int, default=8, help="Retrieval top-k (default 8).")
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    documents = load_golden_v0_documents()
    golden = load_golden_v0_set()

    if args.live:
        result = run_live_comparison(
            golden=golden,
            documents=documents,
            retrieve=_build_live_retrieve(args.live, args.top_k),
        )
        run_name = f"golden-v0 (live full corpus @ {args.live})"
        note = f"Measured over {len(result.items)} golden-v0 item(s) with required cites."
    else:
        corpus = load_fixture_retrieval_corpus()
        result = run_offline_comparison(
            golden=golden, documents=documents, corpus=corpus, top_k=args.top_k
        )
        run_name = "golden-v0 (offline, designed-fixture cites)"
        note = (
            f"Measured over {len(result.items)} golden-v0 item(s) with a fixture-resolvable "
            "required cite. Statute-cite items need the live /retrieve/debug run (--live)."
        )

    print(render_hit_rate_comparison(result.comparison, run_name=run_name))
    print(f"\n{note}", file=sys.stderr)
    return 0


__all__ = [
    "OfflineComparisonResult",
    "RetrieveFn",
    "load_fixture_retrieval_corpus",
    "run_offline_comparison",
    "run_live_comparison",
    "main",
]


if __name__ == "__main__":
    raise SystemExit(main())
