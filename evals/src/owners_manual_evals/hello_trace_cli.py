"""CLI wrapper around :func:`emit_hello_trace`.

Run ``uv run hello-trace`` (after copying .env) to push one trace to the local
Langfuse UI and print its id.
"""

from __future__ import annotations

import sys

from owners_manual_evals.hello_trace import HELLO_TRACE_NAME, emit_hello_trace


def main() -> int:
    try:
        result = emit_hello_trace()
    except RuntimeError as error:
        print(f"hello-trace failed: {error}", file=sys.stderr)
        return 1

    print(
        f"Emitted Python hello trace {result.trace_id} to {result.host}\n"
        f"View it at {result.host}/project (open the project, then Tracing -> "
        f'Traces and filter for "{HELLO_TRACE_NAME}").'
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
