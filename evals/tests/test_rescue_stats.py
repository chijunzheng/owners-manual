"""Per-stage rescue stats (#16 AC1).

The dashboard surface that answers "which required cites did EACH retrieval stage
rescue — and which did it rescue ALONE?" (CONTEXT.md, "Retrieval hit rate":
component value shows up as MECHANISM, not just outcome). Unit-tested here on
SYNTHETIC candidate/cite sets — no live corpus, no network — exactly the
mechanism #23's ablation reads.

Pinned contract:
  * per-stage ``reached`` = required cites some candidate carrying that stage
    reached (hierarchically matched, same matcher as cite grading);
  * per-stage ``rescued_only`` = required cites reached ONLY via that stage and
    by NO other stage — the headline "found only by graph expansion" number;
  * a required cite reached by two stages is rescued-only by neither;
  * refusal items (no required cites) contribute nothing and never error;
  * the render names each stage and the rescued-only count, with no blended scalar.
"""

from __future__ import annotations

from owners_manual_evals.citable_path import CitablePath, CitablePathSegment
from owners_manual_evals.document_tree import parse_document_tree
from owners_manual_evals.rescue_stats import (
    StageCandidate,
    build_rescue_stats,
    render_rescue_stats,
)


def _path(*segments: tuple[str, str], document_id: str = "rta-2006") -> CitablePath:
    return CitablePath(
        document_id=document_id,
        segments=tuple(CitablePathSegment(kind=k, label=lbl) for k, lbl in segments),
    )


def _section(label: str, children: list[dict] | None = None) -> dict:
    return {"kind": "section", "label": label, "children": children or []}


def _tree() -> object:
    # A minimal tree so the matcher can resolve s.20, s.30, s.40.
    return parse_document_tree(
        {
            "kind": "document",
            "label": "rta-2006",
            "documentId": "rta-2006",
            "children": [_section("20"), _section("30"), _section("40")],
        }
    )


_DOCS = (_tree(),)
_S20 = _path(("section", "20"))
_S30 = _path(("section", "30"))
_S40 = _path(("section", "40"))


def _cand(path_key: str, *stages: str) -> StageCandidate:
    return StageCandidate(citable_path_key=path_key, stages=tuple(stages))


def test_reached_counts_cites_any_candidate_with_the_stage_reached() -> None:
    stats = build_rescue_stats(
        required=[_S20, _S30],
        candidates=[
            _cand("rta-2006|section:20", "vector"),
            _cand("rta-2006|section:30", "bm25"),
        ],
        documents=_DOCS,
    )
    by_stage = {row.stage: row for row in stats.rows}
    assert by_stage["vector"].reached == 1
    assert by_stage["bm25"].reached == 1


def test_rescued_only_credits_the_sole_stage_that_reached_a_cite() -> None:
    # s.30 is reached ONLY via graph-expansion; that is the headline rescue number.
    stats = build_rescue_stats(
        required=[_S20, _S30],
        candidates=[
            _cand("rta-2006|section:20", "vector", "bm25"),
            _cand("rta-2006|section:30", "graph-expansion"),
        ],
        documents=_DOCS,
    )
    by_stage = {row.stage: row for row in stats.rows}
    assert by_stage["graph-expansion"].rescued_only == 1
    # s.20 was reached by vector AND bm25 → rescued-only by neither.
    assert by_stage["vector"].rescued_only == 0
    assert by_stage["bm25"].rescued_only == 0


def test_a_cite_reached_by_two_stages_is_rescued_only_by_neither() -> None:
    stats = build_rescue_stats(
        required=[_S20],
        candidates=[_cand("rta-2006|section:20", "vector", "rerank-survivor")],
        documents=_DOCS,
    )
    by_stage = {row.stage: row for row in stats.rows}
    assert by_stage["vector"].reached == 1
    assert by_stage["vector"].rescued_only == 0
    assert by_stage["rerank-survivor"].rescued_only == 0


def test_rescued_only_when_two_separate_candidates_each_carry_a_single_stage() -> None:
    # Same cite reached by two DIFFERENT candidates, each single-stage → two stages
    # reached it, so neither rescued it alone.
    stats = build_rescue_stats(
        required=[_S20],
        candidates=[
            _cand("rta-2006|section:20", "vector"),
            _cand("rta-2006|section:20", "graph-expansion"),
        ],
        documents=_DOCS,
    )
    by_stage = {row.stage: row for row in stats.rows}
    assert by_stage["vector"].rescued_only == 0
    assert by_stage["graph-expansion"].rescued_only == 0


def test_hierarchical_match_descendant_satisfies_required_ancestor() -> None:
    # A candidate at s.20(1) satisfies a required s.20 (descendant covers ancestor).
    tree = parse_document_tree(
        {
            "kind": "document",
            "label": "rta-2006",
            "documentId": "rta-2006",
            "children": [_section("20", [{"kind": "subsection", "label": "1", "children": []}])],
        }
    )
    stats = build_rescue_stats(
        required=[_path(("section", "20"))],
        candidates=[_cand("rta-2006|section:20|subsection:1", "graph-expansion")],
        documents=(tree,),
    )
    by_stage = {row.stage: row for row in stats.rows}
    assert by_stage["graph-expansion"].rescued_only == 1


def test_refusal_item_with_no_required_cites_contributes_nothing() -> None:
    stats = build_rescue_stats(
        required=[],
        candidates=[_cand("rta-2006|section:20", "vector")],
        documents=_DOCS,
    )
    # No required cites → no stage reached or rescued anything; never errors.
    for row in stats.rows:
        assert row.reached == 0
        assert row.rescued_only == 0


def test_aggregates_across_multiple_items() -> None:
    # Two items: graph-expansion uniquely rescues one cite in each → total 2.
    stats = build_rescue_stats_over_items(
        [
            (
                [_S30],
                [
                    _cand("rta-2006|section:20", "vector"),
                    _cand("rta-2006|section:30", "graph-expansion"),
                ],
            ),
            (
                [_S40],
                [_cand("rta-2006|section:40", "graph-expansion")],
            ),
        ]
    )
    by_stage = {row.stage: row for row in stats.rows}
    assert by_stage["graph-expansion"].rescued_only == 2


def build_rescue_stats_over_items(items):
    """Helper bridging the per-item builder to the across-items aggregator."""
    from owners_manual_evals.rescue_stats import aggregate_rescue_stats

    per_item = [
        build_rescue_stats(required=req, candidates=cands, documents=_DOCS) for req, cands in items
    ]
    return aggregate_rescue_stats(per_item)


def test_render_names_each_stage_and_the_rescued_only_count_no_blended_scalar() -> None:
    stats = build_rescue_stats(
        required=[_S20, _S30],
        candidates=[
            _cand("rta-2006|section:20", "vector", "bm25"),
            _cand("rta-2006|section:30", "graph-expansion"),
        ],
        documents=_DOCS,
    )
    text = render_rescue_stats(stats, run_name="golden-v0 fixtures")
    assert "golden-v0 fixtures" in text
    assert "graph-expansion" in text
    assert "rescued only" in text.lower() or "rescued-only" in text.lower()
    assert "blended" not in text.lower()
    assert "composite" not in text.lower()
