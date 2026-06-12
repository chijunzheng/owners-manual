"""Hello-trace for the Python Langfuse SDK (issue #4, AC2).

Emits one visible trace against the configured Langfuse instance and returns
its id. Proves the eval-harness-side (Python) tracing path is wired end-to-end
before any golden-set or RAGAS code exists. The eval harness is the black-box
client of the TS service; this confirms it can write to the sole system of
record.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

#: Default host: the local self-hosted Langfuse UI (Cloud is the env fallback).
LOCAL_LANGFUSE_HOST = "http://localhost:3000"

#: Stable trace name so the emitted trace is easy to find in the Langfuse UI.
HELLO_TRACE_NAME = "owners-manual.hello-trace.py"


class _LangfuseLike(Protocol):
    """The slice of the Langfuse v4 client this module uses."""

    def start_as_current_observation(self, *, name: str, **kwargs: Any) -> Any: ...

    def get_current_trace_id(self) -> str | None: ...

    def flush(self) -> None: ...


LangfuseFactory = Callable[..., _LangfuseLike]


@dataclass(frozen=True)
class HelloTraceResult:
    """Outcome of a hello-trace emission: the trace id and the host it went to."""

    trace_id: str | None
    host: str


def resolve_langfuse_host(env: dict[str, str] | None = None) -> str:
    """Resolve the Langfuse host from ``LANGFUSE_HOST``, defaulting to local.

    An unset or whitespace-only value falls back to :data:`LOCAL_LANGFUSE_HOST`.
    """
    source = os.environ if env is None else env
    host = (source.get("LANGFUSE_HOST") or "").strip()
    return host if host else LOCAL_LANGFUSE_HOST


def _default_langfuse_factory(**kwargs: Any) -> _LangfuseLike:
    """Construct the real Langfuse client, importing the SDK lazily.

    Kept out of module import so the SDK's import-time OTel setup only happens
    when a trace is actually emitted (and so unit tests need not install it).
    """
    from langfuse import Langfuse  # noqa: PLC0415 — lazy import is intentional

    return Langfuse(**kwargs)


def emit_hello_trace(
    *,
    env: dict[str, str] | None = None,
    langfuse_factory: LangfuseFactory | None = None,
) -> HelloTraceResult:
    """Emit exactly one trace via the Python SDK and flush it to the server.

    Reads ``LANGFUSE_PUBLIC_KEY``, ``LANGFUSE_SECRET_KEY``, and ``LANGFUSE_HOST``
    from the environment (see the repo-root ``.env.example``). Raises
    ``RuntimeError`` with a clear message if credentials are missing rather than
    silently no-op'ing.

    Args:
        env: Optional env mapping (defaults to ``os.environ``).
        langfuse_factory: Optional client factory for tests; defaults to the
            real SDK.
    """
    source = os.environ if env is None else env
    public_key = (source.get("LANGFUSE_PUBLIC_KEY") or "").strip()
    secret_key = (source.get("LANGFUSE_SECRET_KEY") or "").strip()

    if not public_key or not secret_key:
        raise RuntimeError(
            "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set "
            "(copy .env.example to .env and fill in the project "
            "keys from the Langfuse UI)."
        )

    host = resolve_langfuse_host(source)
    factory = langfuse_factory or _default_langfuse_factory
    client = factory(public_key=public_key, secret_key=secret_key, host=host)

    # One root observation; its name becomes the trace name in the UI. The
    # context manager opens and closes exactly one span.
    with client.start_as_current_observation(
        name=HELLO_TRACE_NAME,
        as_type="span",
        input={"message": "hello from the Python SDK"},
        metadata={"source": "hello_trace.py", "phase": "phase-0", "sdk": "python"},
    ) as span:
        span.set_trace_io(output={"greeting": "hello, owners-manual"})
        trace_id = client.get_current_trace_id()

    # Flush before returning so the trace is durably sent even for a short-lived
    # process (the SDK batches in the background otherwise).
    client.flush()

    return HelloTraceResult(trace_id=trace_id, host=host)


__all__ = [
    "HELLO_TRACE_NAME",
    "LOCAL_LANGFUSE_HOST",
    "HelloTraceResult",
    "emit_hello_trace",
    "resolve_langfuse_host",
]
