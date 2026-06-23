"""README ablation tables, DERIVED from Langfuse data (issue #23 AC3).

CONTEXT.md ("Disposition"): a committed table is "a release-time export — derived
from Langfuse, never the primary record." README ("Component attribution"): the
ladder "results tables (four-arm, ladders, mechanism stats) are generated from
Langfuse data into the README — derived, never hand-typed — with the order-
dependence caveat printed beside the build-up ladder."

So this module is the AC3 surface, built like :mod:`release_digest`: the pure
:func:`generate_ablation_tables` reads each rung's strict-pass rate (and the
per-stage rescue mechanism rows) back FROM Langfuse through an INJECTED reader and
renders the markdown — rebuilding the tables re-reads Langfuse, never the run's
in-memory numbers. :func:`splice_into_readme` replaces the marked block in place so
the committed README block is regenerated, not hand-edited. The live Langfuse
reader is wired behind the same seam in :mod:`generate_ablation_readme`.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from .ablation_ladders import (
    COMPONENT_KEYS,
    ORDER_DEPENDENCE_CAVEAT,
    require_component,
)

#: The HTML-comment fence the README block is wrapped in, so a regeneration
#: replaces exactly the marked block and never touches the rest of the file
#: (mirrors :data:`smoke_comment.SMOKE_COMMENT_MARKER`).
ABLATION_TABLE_MARKER = "<!-- owners-manual-ablation-ladders -->"


@dataclass(frozen=True, slots=True)
class LadderRowFromLangfuse:
    """One ladder rung's strict-pass rate read back FROM Langfuse.

    ``component_key`` is the component the rung attributes to (added on build-up,
    removed on knock-out) or ``None`` for the build-up ladder's naive-rag floor.
    The rate is read off the rung's traces — the table authors none of it.
    """

    ladder: str
    component_key: str | None
    strict_pass_rate: float


@dataclass(frozen=True, slots=True)
class MechanismRowFromLangfuse:
    """One retrieval stage's rescue stats read back FROM Langfuse (the mechanism
    table): cites it reached and cites it rescued ALONE (#23, :mod:`rescue_stats`)."""

    stage: str
    reached: int
    rescued_only: int


#: The reader the tables are derived from: returns the Langfuse-shaped per-rung
#: ladder rows and the per-stage mechanism rows. Injected so generation is mocked
#: offline; the live binding reads Langfuse scores by run name + rung.
LadderScoreReader = Callable[[], Mapping[str, Sequence[object]]]


def _fmt_pct(value: float) -> str:
    return f"{value:.2%}"


def _fmt_signed_pct(value: float) -> str:
    sign = "+" if value >= 0 else "-"
    return f"{sign}{abs(value):.2%}"


def _label(component_key: str | None) -> str:
    if component_key is None:
        return "naive-rag floor"
    component = require_component(component_key)
    # Name by label plus the stable key the issue/CONTEXT.md use, so the table is
    # readable and grep-able by component key.
    return f"{component.label} (`{component_key}`)"


def _buildup_table(rows: Sequence[LadderRowFromLangfuse]) -> list[str]:
    """The build-up ladder markdown: each component's arrival delta, derived from
    consecutive strict-pass rates read off Langfuse."""
    lines = [
        "#### Build-up ladder — value on arrival",
        "",
        f"_{ORDER_DEPENDENCE_CAVEAT}_",
        "",
        "| rung | component | strict pass | Δ on arrival |",
        "| --- | --- | ---: | ---: |",
    ]
    prev: float | None = None
    for index, row in enumerate(rows):
        if prev is None:
            delta = "—"
        else:
            delta = _fmt_signed_pct(row.strict_pass_rate - prev)
        rate = _fmt_pct(row.strict_pass_rate)
        lines.append(f"| {index} | {_label(row.component_key)} | {rate} | {delta} |")
        prev = row.strict_pass_rate
    return lines


def _knockout_table(
    rows: Sequence[LadderRowFromLangfuse],
    *,
    full_system_rate: float,
) -> list[str]:
    """The knock-out ladder markdown: each component's removal delta against the
    full-system rate, derived from Langfuse (order-free — value in place)."""
    lines = [
        "#### Leave-one-out ladder — value in place (order-free)",
        "",
        f"Full system strict pass: **{_fmt_pct(full_system_rate)}**. "
        "Each row removes ONE component; Δ is the removed arm minus the full system "
        "(a removal that hurts is negative).",
        "",
        "| component removed | strict pass | Δ vs full |",
        "| --- | ---: | ---: |",
    ]
    for row in rows:
        delta = _fmt_signed_pct(row.strict_pass_rate - full_system_rate)
        rate = _fmt_pct(row.strict_pass_rate)
        lines.append(f"| {_label(row.component_key)} | {rate} | {delta} |")
    return lines


def _mechanism_table(rows: Sequence[MechanismRowFromLangfuse]) -> list[str]:
    """The per-stage rescue mechanism markdown (#23): which required cites each
    retrieval stage reached, and which it rescued ALONE."""
    lines = [
        "#### Mechanism stats — per-stage required-cite rescue",
        "",
        "Required cites each retrieval stage reached, and the cites it rescued "
        "ALONE (no other stage reached them) — component value as mechanism, not "
        "just outcome (CONTEXT.md, Retrieval hit rate).",
        "",
        "| stage | reached | rescued only |",
        "| --- | ---: | ---: |",
    ]
    for row in rows:
        lines.append(f"| {row.stage} | {row.reached} | {row.rescued_only} |")
    return lines


def _full_system_rate(buildup: Sequence[LadderRowFromLangfuse]) -> float:
    """The full-system strict-pass rate the knock-out deltas are measured against —
    the build-up ladder's top rung (every component on). Falls back to 0.0 only on
    an empty build-up read (a malformed reader), never a silent wrong anchor."""
    return buildup[-1].strict_pass_rate if buildup else 0.0


def _coerce_ladder_rows(raw: Sequence[object]) -> tuple[LadderRowFromLangfuse, ...]:
    return tuple(row for row in raw if isinstance(row, LadderRowFromLangfuse))


def _coerce_mechanism_rows(raw: Sequence[object]) -> tuple[MechanismRowFromLangfuse, ...]:
    return tuple(row for row in raw if isinstance(row, MechanismRowFromLangfuse))


def generate_ablation_tables(
    *,
    read_ladder_scores: LadderScoreReader,
    run_name: str,
) -> str:
    """Generate the README ablation tables, DERIVED from the injected reader (AC3).

    Reads the per-rung ladder rows and per-stage mechanism rows back from Langfuse
    (the injected ``read_ladder_scores``), then renders the build-up ladder (with
    its order-dependence caveat), the leave-one-out ladder, and the mechanism stats
    as markdown wrapped in :data:`ABLATION_TABLE_MARKER`. Pure given the reader:
    rebuilding re-reads Langfuse, so the committed block is genuinely derived,
    never hand-typed. Raises ``ValueError`` if the build-up component rows are not
    the eight components in dependency order — a derived table must not silently
    drop or reorder a rung.
    """
    data = read_ladder_scores()
    buildup = _coerce_ladder_rows(data.get("buildup", ()))
    knockout = _coerce_ladder_rows(data.get("knockout", ()))
    mechanism = _coerce_mechanism_rows(data.get("mechanism", ()))

    _validate_buildup(buildup)

    full_rate = _full_system_rate(buildup)
    lines = [
        ABLATION_TABLE_MARKER,
        "",
        f"### Two-ladder ablation — `{run_name}`",
        "",
        "_Derived from Langfuse, never hand-typed: regenerated by "
        "`uv run generate-ablation-readme`. Langfuse is the primary record; this "
        "block is a derived view._",
        "",
        *_buildup_table(buildup),
        "",
        *_knockout_table(knockout, full_system_rate=full_rate),
        "",
        *_mechanism_table(mechanism),
        "",
        ABLATION_TABLE_MARKER,
    ]
    return "\n".join(lines)


def _validate_buildup(buildup: Sequence[LadderRowFromLangfuse]) -> None:
    """The build-up read must be the floor plus the eight components in dependency
    order — so a derived table cannot silently drop or reorder a rung."""
    component_rows = [row.component_key for row in buildup if row.component_key is not None]
    if tuple(component_rows) != COMPONENT_KEYS:
        raise ValueError(
            "build-up ladder read from Langfuse must cover the eight components in "
            f"dependency order; got {component_rows}"
        )


def splice_into_readme(readme: str, tables: str) -> str:
    """Replace the marked ablation block in ``readme`` with ``tables`` (idempotent).

    Finds the pair of :data:`ABLATION_TABLE_MARKER` fences and swaps the block
    between them; with no marker present, appends the block at the end. Idempotent:
    splicing the same tables twice is a no-op. Raises ``ValueError`` on an
    UNBALANCED marker (exactly one fence) — a corrupt block whose silent overwrite
    would swallow the rest of the file.
    """
    count = readme.count(ABLATION_TABLE_MARKER)
    if count == 0:
        separator = "" if readme.endswith("\n\n") else ("\n" if readme.endswith("\n") else "\n\n")
        return f"{readme}{separator}{tables}\n"
    if count < 2:
        raise ValueError(
            "README has an unbalanced ablation-table marker (need a matching pair "
            "of fences); refusing to splice and risk swallowing the file"
        )

    start = readme.index(ABLATION_TABLE_MARKER)
    end = readme.index(ABLATION_TABLE_MARKER, start + len(ABLATION_TABLE_MARKER))
    end += len(ABLATION_TABLE_MARKER)
    return readme[:start] + tables + readme[end:]


# --- live CLI wiring -------------------------------------------------------


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no cover - live wiring
    """Live entry point: read each rung's scores back FROM Langfuse and regenerate
    the README ablation block (AC3, derived — never hand-typed).

    The live Langfuse reader (in :mod:`live_ablation_scores`) aggregates each
    rung's strict-pass scores by the ``{run_name}:{rung_id}`` run name the runner
    tagged them with, then this CLI renders the tables and either prints them or
    splices them into the README in place (``--write``). Rebuilding re-reads
    Langfuse, so the committed block is a derived view, never a primary record.
    """
    import argparse  # noqa: PLC0415
    import sys  # noqa: PLC0415
    from pathlib import Path  # noqa: PLC0415

    parser = argparse.ArgumentParser(
        prog="generate-ablation-readme",
        description="Generate the README two-ladder ablation tables from Langfuse data "
        "(derived, never hand-typed).",
    )
    parser.add_argument("--run-name", default="ablation-ladders-v0")
    parser.add_argument(
        "--readme",
        default=None,
        help="Path to the README to splice into (default: repo-root README.md).",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="Splice the tables into the README in place (default: print to stdout).",
    )
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    from .env_file import load_root_env  # noqa: PLC0415

    load_root_env()
    from .live_ablation_scores import build_ladder_score_reader  # noqa: PLC0415
    from .live_runner import _build_langfuse  # noqa: PLC0415

    try:
        langfuse = _build_langfuse()
    except RuntimeError as error:
        print(f"Cannot read ablation scores: {error}", file=sys.stderr)
        return 2

    tables = generate_ablation_tables(
        read_ladder_scores=build_ladder_score_reader(langfuse, run_name=args.run_name),
        run_name=args.run_name,
    )

    if not args.write:
        print(tables)
        return 0

    readme_path = Path(args.readme) if args.readme else _default_readme_path()
    spliced = splice_into_readme(readme_path.read_text(encoding="utf-8"), tables)
    readme_path.write_text(spliced, encoding="utf-8")
    print(f"Spliced ablation tables into {readme_path}", file=sys.stderr)
    return 0


def _default_readme_path():  # pragma: no cover - live wiring
    """The repo-root README.md, relative to this file (evals/src/...→ repo root)."""
    from pathlib import Path  # noqa: PLC0415

    return Path(__file__).resolve().parents[3] / "README.md"


__all__ = [
    "ABLATION_TABLE_MARKER",
    "LadderRowFromLangfuse",
    "MechanismRowFromLangfuse",
    "LadderScoreReader",
    "generate_ablation_tables",
    "splice_into_readme",
    "main",
]


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
