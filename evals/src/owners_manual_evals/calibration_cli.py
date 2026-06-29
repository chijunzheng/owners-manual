"""Calibration CLI: slice → blind sheet → κ, on its own path (issue #19, ADR 0010).

Decision 7 runs calibration EARLY, on its own CLI path, off the #21 disposition
pre-flight gate. This is the thin, LIVE-by-design entry point that wires the file
IO around the already-tested pure helpers — :func:`calibration_slice`,
:func:`calibration_labels`, :func:`calibration`, and :func:`calibration_report`.
Like :func:`run_variance.main` it is ``# pragma: no cover``: the logic it calls is
unit-tested; only the argparse + read/write/print shell here is uninstrumented.

Subcommands::

    calibrate slice  [--seed 19] [--size 20]
        Regenerate the frozen slice manifest from the golden set.

    calibrate sheet  --answers answers.json [--out -]
        Emit the BLIND labeling sheet (one row per slice (item, point)) from a
        {item_id: answer_text} map — no judge verdict ever attached (Decision 5).

    calibrate kappa  --labels labels.yaml --judge claude.json [--gemini gemini.json]
        Compute Cohen's κ from the filled labels + the judge verdict map(s) and
        print the README calibration table (Decision 3 / Decision 6).
"""

from __future__ import annotations

import sys
from collections.abc import Sequence

#: The default calibration seed (the issue number) — pins the frozen slice manifest.
DEFAULT_CALIBRATION_SEED = 19


def _parse_args(argv: Sequence[str]):  # noqa: ANN202 — argparse.Namespace  # pragma: no cover
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(
        prog="calibrate",
        description="Judge calibration: regenerate the slice, emit the blind labeling "
        "sheet, and compute judge–human / judge–judge κ (ADR 0010). Runs early, off "
        "the disposition gate (Decision 7).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    slice_cmd = sub.add_parser("slice", help="regenerate the frozen slice manifest")
    slice_cmd.add_argument("--seed", type=int, default=DEFAULT_CALIBRATION_SEED)
    slice_cmd.add_argument("--size", type=int, default=20)

    sheet_cmd = sub.add_parser("sheet", help="emit the blind labeling sheet")
    sheet_cmd.add_argument("--answers", required=True, help="JSON {item_id: answer_text}")
    sheet_cmd.add_argument("--out", default="-", help="output path, or - for stdout")

    kappa_cmd = sub.add_parser("kappa", help="compute κ and print the calibration table")
    kappa_cmd.add_argument("--labels", required=True, help="filled labels.yaml")
    kappa_cmd.add_argument(
        "--judge", required=True, help="JSON {item_id: {point_id: bool}} (Claude)"
    )
    kappa_cmd.add_argument(
        "--gemini", default=None, help="JSON {item_id: {point_id: bool}} (Gemini)"
    )
    kappa_cmd.add_argument("--seed", type=int, default=DEFAULT_CALIBRATION_SEED)
    return parser.parse_args(argv)


def _load_slice():  # noqa: ANN202  # pragma: no cover - live wiring
    """The committed slice manifest (for behavior-class strata + the item set)."""
    from .calibration_slice import SLICE_MANIFEST_FILENAME, parse_slice_manifest  # noqa: PLC0415
    from .golden_fixtures import resolve_fixtures_dir  # noqa: PLC0415

    path = resolve_fixtures_dir().parent / "calibration" / SLICE_MANIFEST_FILENAME
    return parse_slice_manifest(path.read_text(encoding="utf-8"))


def _command_slice(args) -> int:  # pragma: no cover - live wiring
    from .calibration_slice import (  # noqa: PLC0415
        SLICE_MANIFEST_FILENAME,
        render_slice_manifest,
        select_calibration_slice,
    )
    from .golden_fixtures import resolve_fixtures_dir  # noqa: PLC0415
    from .golden_split import assign_split  # noqa: PLC0415
    from .golden_v0 import load_golden_v0_set  # noqa: PLC0415

    golden = load_golden_v0_set()
    sides = assign_split(golden.items)
    chosen = select_calibration_slice(golden.items, sides=sides, size=args.size, seed=args.seed)
    out = resolve_fixtures_dir().parent / "calibration" / SLICE_MANIFEST_FILENAME
    out.write_text(render_slice_manifest(chosen), encoding="utf-8")
    print(f"Wrote {chosen.size}-item calibration slice to {out}", file=sys.stderr)
    return 0


def _command_sheet(args) -> int:  # pragma: no cover - live wiring
    import json  # noqa: PLC0415

    from .calibration_labels import build_labeling_sheet, render_labeling_sheet  # noqa: PLC0415
    from .golden_v0 import load_golden_v0_set  # noqa: PLC0415

    answers = json.loads(open(args.answers, encoding="utf-8").read())
    manifest = _load_slice()
    slice_ids = {entry.item_id for entry in manifest.entries}
    by_id = {item.id: item for item in load_golden_v0_set().items}

    rows = []
    for item_id in (entry.item_id for entry in manifest.entries):
        if item_id not in answers:
            raise SystemExit(f"no answer text provided for slice item {item_id!r}")
        rows.extend(build_labeling_sheet(by_id[item_id], answer_text=answers[item_id]))
    _ = slice_ids
    rendered = render_labeling_sheet(rows)
    if args.out == "-":
        print(rendered)
    else:
        open(args.out, "w", encoding="utf-8").write(rendered)
        print(f"Wrote blind labeling sheet ({len(rows)} rows) to {args.out}", file=sys.stderr)
    return 0


def _command_kappa(args) -> int:  # pragma: no cover - live wiring
    import json  # noqa: PLC0415

    from .calibration import PointAgreement, compute_calibration  # noqa: PLC0415
    from .calibration_labels import parse_labels  # noqa: PLC0415
    from .calibration_report import (  # noqa: PLC0415
        PointDecision,
        judge_judge_kappas,
        render_calibration_table,
    )

    labels = parse_labels(open(args.labels, encoding="utf-8").read())
    claude = json.loads(open(args.judge, encoding="utf-8").read())
    behavior_class_by_item = {e.item_id: e.behavior_class for e in _load_slice().entries}

    agreements = tuple(
        PointAgreement(
            item_id=row.item_id,
            point_id=row.point_id,
            behavior_class=behavior_class_by_item.get(row.item_id, "answer"),
            human_credited=bool(row.human_credited),
            judge_credited=bool(claude[row.item_id][row.point_id]),
        )
        for row in labels
    )
    primary = compute_calibration(agreements, seed=args.seed)

    if args.gemini is None:
        print(f"κ(Claude↔human) = {primary.kappa:.2f}  (provide --gemini for the full table)")
        return 0

    gemini = json.loads(open(args.gemini, encoding="utf-8").read())
    human_stream = [
        PointDecision(
            row.item_id,
            row.point_id,
            behavior_class_by_item.get(row.item_id, "answer"),
            bool(row.human_credited),
        )
        for row in labels
    ]
    claude_stream = [
        PointDecision(
            row.item_id,
            row.point_id,
            behavior_class_by_item.get(row.item_id, "answer"),
            bool(claude[row.item_id][row.point_id]),
        )
        for row in labels
    ]
    gemini_stream = [
        PointDecision(
            row.item_id,
            row.point_id,
            behavior_class_by_item.get(row.item_id, "answer"),
            bool(gemini[row.item_id][row.point_id]),
        )
        for row in labels
    ]
    judge_judge = judge_judge_kappas(human=human_stream, claude=claude_stream, gemini=gemini_stream)
    print(render_calibration_table(primary=primary, judge_judge=judge_judge))
    return 0


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no cover - live wiring
    """Dispatch the calibration subcommand. Live by design (IO + print)."""
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == "slice":
        return _command_slice(args)
    if args.command == "sheet":
        return _command_sheet(args)
    if args.command == "kappa":
        return _command_kappa(args)
    return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
