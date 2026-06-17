"""Generate the committed release failure digest (issue #21 AC4).

The release-time export that renders the clustered failure digest (stage ×
behavior class × corpus) as a committed DERIVED artifact (CONTEXT.md,
"Disposition": "derived from Langfuse, never the primary record"). The pure
orchestration (:func:`generate_release_digest`) reads the dispositioned failures
through an INJECTED reader and builds + renders the digest, so it is exercised
offline with no server; the ``main`` CLI wires the live Langfuse reader behind
the same seam and writes the artifact to disk.
"""

from __future__ import annotations

import sys
from collections.abc import Callable, Sequence

from .failure_digest import DispositionedFailure, build_failure_digest, render_failure_digest

#: A reader of the dispositioned failures from Langfuse — injected so the
#: generation path is mocked. The live binding is ``live_annotation_queue``.
DispositionedFailureReader = Callable[[], Sequence[DispositionedFailure]]


def generate_release_digest(
    *,
    read_dispositioned_failures: DispositionedFailureReader,
    run_name: str,
) -> str:
    """Read the dispositioned failures (from Langfuse), cluster, and render.

    Pure given the injected reader: the digest is built ONLY from what the reader
    returns, so rebuilding it re-reads Langfuse — it is genuinely derived, never
    a primary record of its own.
    """
    digest = build_failure_digest(read_dispositioned_failures())
    return render_failure_digest(digest, run_name=run_name)


# --- live CLI wiring -------------------------------------------------------


def _parse_args(argv: Sequence[str]):  # noqa: ANN202 - argparse.Namespace; pragma: no cover
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(
        prog="release-digest",
        description="Export the clustered failure digest (stage × behavior × corpus) from "
        "Langfuse dispositions as a committed derived artifact.",
    )
    parser.add_argument("--run-name", default="release", help="Run name in the digest header.")
    parser.add_argument(
        "--out",
        default=None,
        help="Write the digest to this path (default: print to stdout).",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no cover - live wiring
    """Live entry point: read dispositions from Langfuse and emit the digest."""
    args = _parse_args(sys.argv[1:] if argv is None else argv)

    from .env_file import load_root_env  # noqa: PLC0415

    load_root_env()
    from .live_annotation_queue import (  # noqa: PLC0415
        read_dispositioned_failures,
        resolve_queue_id,
    )
    from .live_runner import _build_langfuse  # noqa: PLC0415

    try:
        langfuse = _build_langfuse()
        queue_id = resolve_queue_id()
    except RuntimeError as error:
        print(f"Cannot export the release digest: {error}", file=sys.stderr)
        return 2

    text = generate_release_digest(
        read_dispositioned_failures=lambda: read_dispositioned_failures(
            langfuse, queue_id=queue_id
        ),
        run_name=args.run_name,
    )

    if args.out is None:
        print(text)
    else:
        from pathlib import Path  # noqa: PLC0415

        Path(args.out).write_text(text + "\n", encoding="utf-8")
        print(f"Wrote release failure digest to {args.out}", file=sys.stderr)
    return 0


__all__ = ["DispositionedFailureReader", "generate_release_digest", "main"]


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
