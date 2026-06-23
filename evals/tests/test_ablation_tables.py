"""README-table generation tests (issue #23 AC3): tables DERIVED from Langfuse.

AC3 — "README tables generated from Langfuse data." Following the release-digest
pattern (CONTEXT.md, "Disposition": derived from Langfuse, never the primary
record), the generation is a PURE function over an INJECTED Langfuse reader: it
reads each rung's strict-pass rate back FROM Langfuse and renders the markdown
tables (the two ladders + the per-stage mechanism stats), so rebuilding the tables
re-reads Langfuse — they are genuinely derived, never hand-typed. A stable README
marker lets the same block be replaced in place.

The reader is the mocked seam (the live binding reads Langfuse scores by run name
+ rung); the rendering and the marker splice are pinned here against a fake reader
that returns Langfuse-shaped per-rung rows.
"""

from __future__ import annotations

from owners_manual_evals.ablation_ladders import COMPONENT_KEYS
from owners_manual_evals.ablation_tables import (
    ABLATION_TABLE_MARKER,
    LadderRowFromLangfuse,
    MechanismRowFromLangfuse,
    generate_ablation_tables,
    splice_into_readme,
)


def _fake_reader() -> dict:
    """A Langfuse-shaped read: per-rung strict pass for both ladders, plus the
    per-stage rescue mechanism rows — the shape the live Langfuse reader returns."""
    buildup = (LadderRowFromLangfuse(ladder="build-up", component_key=None, strict_pass_rate=0.20),)
    buildup += tuple(
        LadderRowFromLangfuse(
            ladder="build-up",
            component_key=key,
            strict_pass_rate=0.20 + 0.05 * (i + 1),
        )
        for i, key in enumerate(COMPONENT_KEYS)
    )
    knockout = tuple(
        LadderRowFromLangfuse(
            ladder="knock-out",
            component_key=key,
            strict_pass_rate=0.60 - 0.02,
        )
        for key in COMPONENT_KEYS
    )
    mechanism = (
        MechanismRowFromLangfuse(stage="graph-expansion", reached=12, rescued_only=4),
        MechanismRowFromLangfuse(stage="rerank-survivor", reached=20, rescued_only=1),
    )
    return {"buildup": buildup, "knockout": knockout, "mechanism": mechanism}


def test_tables_are_built_only_from_the_injected_reader() -> None:
    data = _fake_reader()
    calls = {"n": 0}

    def read():
        calls["n"] += 1
        return data

    tables = generate_ablation_tables(read_ladder_scores=read, run_name="ablation-v1")
    # The reader is the ONLY data source — derived, never hand-typed.
    assert calls["n"] == 1
    assert "ablation-v1" in tables
    # Both ladders and the mechanism stats render as markdown tables.
    assert tables.count("| ---") >= 3 or tables.count("|---") >= 3


def test_tables_carry_the_stable_readme_marker() -> None:
    tables = generate_ablation_tables(read_ladder_scores=_fake_reader, run_name="ablation-v1")
    assert ABLATION_TABLE_MARKER in tables


def test_buildup_table_shows_each_components_arrival_delta_derived() -> None:
    tables = generate_ablation_tables(read_ladder_scores=_fake_reader, run_name="ablation-v1")
    # Each build-up component is named in dependency order; the floor is present.
    for key in COMPONENT_KEYS:
        assert key in tables
    assert "naive-rag" in tables.lower()
    # The order-dependence caveat sits beside the build-up ladder (never hidden).
    assert "order-dependent" in tables.lower() or "order dependence" in tables.lower()


def test_mechanism_table_shows_rescued_only_counts() -> None:
    tables = generate_ablation_tables(read_ladder_scores=_fake_reader, run_name="ablation-v1")
    # The "rescued only" mechanism number (#23: which cites a stage found alone).
    assert "rescued" in tables.lower()
    assert "graph-expansion" in tables


def test_splice_replaces_only_the_marked_block_idempotently() -> None:
    tables = generate_ablation_tables(read_ladder_scores=_fake_reader, run_name="ablation-v1")
    readme = (
        "# Project\n\nIntro paragraph.\n\n"
        f"{ABLATION_TABLE_MARKER}\nOLD TABLE CONTENT\n{ABLATION_TABLE_MARKER}\n\n"
        "## Next section\nUntouched.\n"
    )
    spliced = splice_into_readme(readme, tables)
    # Surrounding content is preserved; the old block is gone; the new is in.
    assert "Intro paragraph." in spliced
    assert "## Next section" in spliced
    assert "OLD TABLE CONTENT" not in spliced
    assert "ablation-v1" in spliced
    # Idempotent: splicing the same tables again is a no-op.
    assert splice_into_readme(spliced, tables) == spliced


def test_splice_appends_block_when_no_marker_present() -> None:
    tables = generate_ablation_tables(read_ladder_scores=_fake_reader, run_name="ablation-v1")
    readme = "# Project\n\nNo marker here yet.\n"
    spliced = splice_into_readme(readme, tables)
    assert "No marker here yet." in spliced
    assert spliced.count(ABLATION_TABLE_MARKER) == 2  # opening + closing fence


def test_committed_readme_has_the_marker_and_splice_round_trips() -> None:
    # AC3 "into the README": the committed README must carry the ablation marker
    # block so the live generator replaces exactly that block — and splicing must
    # preserve everything around it. Guards against the README marker drifting from
    # ABLATION_TABLE_MARKER.
    from pathlib import Path

    readme_path = Path(__file__).resolve().parents[2] / "README.md"
    readme = readme_path.read_text(encoding="utf-8")
    assert readme.count(ABLATION_TABLE_MARKER) == 2

    tables = generate_ablation_tables(read_ladder_scores=_fake_reader, run_name="ablation-v1")
    spliced = splice_into_readme(readme, tables)
    # The marquee sections around the block survive the splice.
    assert "## Stack" in spliced
    assert "Component attribution" in spliced
    assert "ablation-v1" in spliced
    # Idempotent against the real README too.
    assert splice_into_readme(spliced, tables) == spliced


def test_splice_rejects_an_unbalanced_existing_marker() -> None:
    # A README with a single (unbalanced) marker is a corrupt block — splicing
    # would silently swallow the rest of the file, so it must raise instead.
    tables = generate_ablation_tables(read_ladder_scores=_fake_reader, run_name="ablation-v1")
    readme = f"# Project\n\n{ABLATION_TABLE_MARKER}\nhalf a block, no closing fence\n"
    try:
        splice_into_readme(readme, tables)
    except ValueError as error:
        assert "marker" in str(error).lower()
    else:  # pragma: no cover
        raise AssertionError("expected a ValueError for an unbalanced marker")
