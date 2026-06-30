"""Calibration CLI: run → blind sheet → κ → triage, on its own path (issue #19, ADR 0010).

Decision 7 runs calibration EARLY, on its own CLI path, off the #21 disposition
pre-flight gate. This is the thin, LIVE-by-design entry point that wires the file
IO around the already-tested pure helpers — :func:`calibration_slice`,
:func:`calibration_run`, :func:`calibration_labels`, :func:`calibration`,
:func:`calibration_corrections`, :func:`calibration_triage`, and
:func:`calibration_report`. Like :func:`run_variance.main` it is ``# pragma: no
cover``: the logic it calls is unit-tested; only the argparse + read/write/print
shell here (and the live model calls) is uninstrumented.

The live-run-day runbook (ADR 0010 "Execution runbook") is exactly this command
sequence: ``run`` → ``sheet`` → blind-label → ``kappa`` → ``triage`` (+ golden edit)
→ publish. Blind labeling is the ONLY manual step.

Subcommands::

    calibrate slice  [--seed 19] [--size 20]
        Regenerate the frozen slice manifest from the golden set.

    calibrate run    [--out-dir .] [--seed 19] [--service-url URL]
        The INPUT PRODUCER: over the frozen slice, run the AGENT arm to produce each
        item's answer (answers.json), then the Claude PRIMARY and Gemini SECONDARY
        judges over the SAME answers (claude.json / gemini.json). All three raters —
        and the human via the sheet — grade the IDENTICAL agent-arm answer.

    calibrate sheet  --answers answers.json [--out -]
        Emit the BLIND labeling sheet (one row per slice (item, point)) from the
        {item_id: answer_text} map — no judge verdict ever attached (Decision 5); the
        header carries the judge's verbatim credit rule so the human grades the same
        construct (the build's decision 2).

    calibrate kappa  --labels labels.yaml --judge claude.json [--gemini gemini.json]
        Compute Cohen's κ from the filled labels + the judge verdict map(s) and
        print the README calibration table (Decision 3 / Decision 6).

    calibrate triage --labels labels.yaml --judge claude.json --corrections corrections.yaml
        Triage every judge↔human mismatch (corrections.yaml), apply the relabels
        ONCE, recompute κ ONCE, and print BOTH the before-κ and after-κ tables, the
        per-bucket counts, and each correction's written justification (Decision 4).
        Every rubric-wrong ALSO obliges a committed golden-point edit (see the ADR).
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

    run_cmd = sub.add_parser(
        "run",
        help="produce the three input files (answers.json + claude.json + gemini.json)",
    )
    run_cmd.add_argument(
        "--out-dir", default=".", help="directory to write answers/claude/gemini.json into"
    )
    run_cmd.add_argument("--seed", type=int, default=DEFAULT_CALIBRATION_SEED)
    run_cmd.add_argument(
        "--service-url",
        default="http://127.0.0.1:8787",
        help="the agent service URL the agent arm drives to produce each answer",
    )
    run_cmd.add_argument(
        "--run-name",
        default="calibration",
        help="run name for the agent arm's deterministic offline trace ids",
    )

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

    triage_cmd = sub.add_parser(
        "triage",
        help="triage mismatches, apply relabels once, recompute κ once, print both tables",
    )
    triage_cmd.add_argument("--labels", required=True, help="filled labels.yaml")
    triage_cmd.add_argument(
        "--judge", required=True, help="JSON {item_id: {point_id: bool}} (Claude)"
    )
    triage_cmd.add_argument(
        "--corrections", required=True, help="corrections.yaml (one row per mismatch)"
    )
    triage_cmd.add_argument("--seed", type=int, default=DEFAULT_CALIBRATION_SEED)
    return parser.parse_args(argv)


def _load_slice():  # noqa: ANN202  # pragma: no cover - live wiring
    """The committed slice manifest (for behavior-class strata + the item set)."""
    from .calibration_slice import SLICE_MANIFEST_FILENAME, parse_slice_manifest  # noqa: PLC0415
    from .golden_fixtures import resolve_fixtures_dir  # noqa: PLC0415

    path = resolve_fixtures_dir().parent / "calibration" / SLICE_MANIFEST_FILENAME
    return parse_slice_manifest(path.read_text(encoding="utf-8"))


def _load_golden_items():  # noqa: ANN202  # pragma: no cover - live wiring
    """The golden v0 items, keyed by the live commands that grade the slice."""
    from .golden_v0 import load_golden_v0_set  # noqa: PLC0415

    return load_golden_v0_set().items


def _write_json(path, payload) -> None:  # noqa: ANN001  # pragma: no cover - live wiring
    """Write a calibration JSON artifact, pretty + key-sorted for a stable diff."""
    import json  # noqa: PLC0415

    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


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


def _command_run(args) -> int:  # pragma: no cover - live wiring
    """The INPUT PRODUCER (ADR 0010 Decision 7): over the frozen slice, run the agent
    arm once per item to produce answers.json, then the Claude PRIMARY and Gemini
    SECONDARY judges over the SAME answers to produce claude.json / gemini.json.

    The single source of answer text is answers.json: both judges grade the identical
    agent-arm answer (and so will the human via the sheet), so the three κ pair on one
    construct. The agent arm + both judges are live model calls; the pure shaping into
    JSON is :mod:`calibration_run`, unit-tested. Runs OFF the disposition gate (it does
    not touch the annotation queue): the slice-only run never spends the four-arm
    matrix's GCP credit and never gates on #21.
    """
    from pathlib import Path  # noqa: PLC0415

    from .agent_live_runner import build_agent_answer  # noqa: PLC0415
    from .calibration_run import (  # noqa: PLC0415
        answers_map_from_outcomes,
        verdict_map_from_judge_results,
    )
    from .env_file import load_root_env  # noqa: PLC0415
    from .judge import judge_item  # noqa: PLC0415
    from .judge_gemini_live import build_gemini_judge  # noqa: PLC0415
    from .judge_live import build_claude_judge  # noqa: PLC0415

    load_root_env()
    manifest = _load_slice()
    by_id = {item.id: item for item in _load_golden_items()}
    slice_items = [by_id[entry.item_id] for entry in manifest.entries]

    # 1) The agent arm produces one answer per slice item (offline trace ids; no
    #    Langfuse export needed — answers.json is the committed artifact).
    answer = build_agent_answer(service_url=args.service_url, run_name=args.run_name, langfuse=None)
    outcomes = [answer(item) for item in slice_items]
    # answers.json is the SINGLE source of answer text fed to both judges (and, via
    # `calibrate sheet`, to the human) — so all three raters grade the identical answer.
    answers = answers_map_from_outcomes(outcomes)

    # 2) The Claude PRIMARY and Gemini SECONDARY judges grade the SAME answers.
    claude = build_claude_judge()
    gemini = build_gemini_judge()
    claude_results = [
        judge_item(item, answer_text=answers[item.id], judge_client=claude) for item in slice_items
    ]
    gemini_results = [
        judge_item(item, answer_text=answers[item.id], judge_client=gemini) for item in slice_items
    ]

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    _write_json(out_dir / "answers.json", answers)
    _write_json(out_dir / "claude.json", verdict_map_from_judge_results(claude_results))
    _write_json(out_dir / "gemini.json", verdict_map_from_judge_results(gemini_results))
    print(
        f"Wrote answers.json + claude.json + gemini.json for {len(slice_items)} slice "
        f"item(s) to {out_dir}",
        file=sys.stderr,
    )
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

    from .calibration import PointAgreement, compute_calibration, require_verdict  # noqa: PLC0415
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
            human_credited=row.human_credited,
            judge_credited=require_verdict(claude, item_id=row.item_id, point_id=row.point_id),
        )
        for row in labels
    )
    primary = compute_calibration(agreements, seed=args.seed)

    if args.gemini is None:
        # No Gemini diagnostic, but κ still travels with its CI, observed agreement,
        # prevalence, and the per-class headline (ADR 0010 Decision 3) — never a bare κ.
        print(render_calibration_table(primary=primary))
        return 0

    gemini = json.loads(open(args.gemini, encoding="utf-8").read())
    human_stream = [
        PointDecision(
            row.item_id,
            row.point_id,
            behavior_class_by_item.get(row.item_id, "answer"),
            row.human_credited,
        )
        for row in labels
    ]
    claude_stream = [
        PointDecision(
            row.item_id,
            row.point_id,
            behavior_class_by_item.get(row.item_id, "answer"),
            require_verdict(claude, item_id=row.item_id, point_id=row.point_id),
        )
        for row in labels
    ]
    gemini_stream = [
        PointDecision(
            row.item_id,
            row.point_id,
            behavior_class_by_item.get(row.item_id, "answer"),
            require_verdict(gemini, item_id=row.item_id, point_id=row.point_id),
        )
        for row in labels
    ]
    judge_judge = judge_judge_kappas(human=human_stream, claude=claude_stream, gemini=gemini_stream)
    print(render_calibration_table(primary=primary, judge_judge=judge_judge))
    return 0


def _command_triage(args) -> int:  # pragma: no cover - live wiring
    """Triage every judge↔human mismatch, apply the relabels ONCE, recompute κ ONCE,
    and print BOTH the before-κ and after-κ tables, the per-bucket counts, and each
    correction's WRITTEN justification (ADR 0010 Decision 4).

    Builds the :class:`PointAgreement`s from the filled labels + the Claude verdicts
    (the SAME pairing as ``kappa``: ``require_verdict`` + the ``behavior_class_by_item``
    lookup), parses corrections.yaml strictly (the written-justification discipline +
    the relabel ⇄ bucket coupling), and calls :func:`triage_and_recompute`. There is
    NO iterate-to-target: the published κ is the honest single-pass value. Each
    rubric-wrong call ALSO obliges a committed golden-point edit (see the ADR runbook).
    """
    import json  # noqa: PLC0415

    from .calibration import PointAgreement, require_verdict  # noqa: PLC0415
    from .calibration_corrections import parse_corrections_with_justifications  # noqa: PLC0415
    from .calibration_labels import parse_labels  # noqa: PLC0415
    from .calibration_report import render_calibration_table  # noqa: PLC0415
    from .calibration_triage import triage_and_recompute  # noqa: PLC0415

    labels = parse_labels(open(args.labels, encoding="utf-8").read())
    claude = json.loads(open(args.judge, encoding="utf-8").read())
    behavior_class_by_item = {e.item_id: e.behavior_class for e in _load_slice().entries}

    agreements = tuple(
        PointAgreement(
            item_id=row.item_id,
            point_id=row.point_id,
            behavior_class=behavior_class_by_item.get(row.item_id, "answer"),
            human_credited=row.human_credited,
            judge_credited=require_verdict(claude, item_id=row.item_id, point_id=row.point_id),
        )
        for row in labels
    )

    parsed = parse_corrections_with_justifications(open(args.corrections, encoding="utf-8").read())
    corrections = tuple(p.correction for p in parsed)
    result = triage_and_recompute(agreements, corrections=corrections, seed=args.seed)

    print("BEFORE corrections:\n")
    print(render_calibration_table(primary=result.before))
    print("\nAFTER corrections (applied once, recomputed once):\n")
    print(render_calibration_table(primary=result.after))

    print("\nTriage buckets:")
    for bucket, count in sorted(result.report.bucket_counts.items()):
        print(f"  {bucket}: {count}")

    print("\nJustifications (the written-justification discipline, ADR 0010 Decision 4):")
    for p in parsed:
        relabel = (
            ""
            if p.correction.corrected_human_credited is None
            else f" → human_credited={p.correction.corrected_human_credited}"
        )
        print(
            f"  [{p.correction.bucket}] {p.correction.item_id}/{p.correction.point_id}"
            f"{relabel}: {p.justification}"
        )
    print(
        "\nReminder: every rubric-wrong correction obliges a committed golden-point edit "
        "on the dev split (ADR 0010 Decision 4; the holdout stays sealed)."
    )
    return 0


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no cover - live wiring
    """Dispatch the calibration subcommand. Live by design (IO + print)."""
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    if args.command == "slice":
        return _command_slice(args)
    if args.command == "run":
        return _command_run(args)
    if args.command == "sheet":
        return _command_sheet(args)
    if args.command == "kappa":
        return _command_kappa(args)
    if args.command == "triage":
        return _command_triage(args)
    return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
