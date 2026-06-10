"""Unit tests for the Python Langfuse hello-trace (issue #4, AC2).

CI-safe: the Langfuse SDK is fully mocked, so these run with no server, no
secrets, and no network — the live trace is demonstrated locally and recorded
in the PR body.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from owners_manual_evals.hello_trace import (
    HELLO_TRACE_NAME,
    LOCAL_LANGFUSE_HOST,
    emit_hello_trace,
    resolve_langfuse_host,
)


def _make_fake_langfuse() -> tuple[MagicMock, MagicMock]:
    """Return (Langfuse class mock, client instance mock) wired like the v4 SDK."""
    client = MagicMock(name="LangfuseClient")

    span_cm = MagicMock(name="span_context_manager")
    span_cm.__enter__.return_value = SimpleNamespace(update=MagicMock(), set_trace_io=MagicMock())
    span_cm.__exit__.return_value = False
    client.start_as_current_observation.return_value = span_cm

    client.get_current_trace_id.return_value = "py-trace-id"

    langfuse_cls = MagicMock(name="Langfuse", return_value=client)
    return langfuse_cls, client


def test_resolve_host_defaults_to_local_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LANGFUSE_HOST", raising=False)
    assert resolve_langfuse_host() == LOCAL_LANGFUSE_HOST


def test_resolve_host_honours_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LANGFUSE_HOST", "https://cloud.langfuse.com")
    assert resolve_langfuse_host() == "https://cloud.langfuse.com"


def test_emits_one_named_trace_and_flushes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-test")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-test")
    monkeypatch.setenv("LANGFUSE_HOST", "http://localhost:3000")
    langfuse_cls, client = _make_fake_langfuse()

    result = emit_hello_trace(langfuse_factory=langfuse_cls)

    # Exactly one client built, from the env contract.
    langfuse_cls.assert_called_once()
    _, kwargs = langfuse_cls.call_args
    assert kwargs["public_key"] == "pk-lf-test"
    assert kwargs["secret_key"] == "sk-lf-test"
    assert kwargs["host"] == "http://localhost:3000"

    # Exactly one named trace span, then a flush.
    client.start_as_current_observation.assert_called_once()
    _, span_kwargs = client.start_as_current_observation.call_args
    assert span_kwargs["name"] == HELLO_TRACE_NAME
    client.flush.assert_called_once()

    assert result.trace_id == "py-trace-id"
    assert result.host == "http://localhost:3000"


def test_falls_back_to_local_host_when_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-test")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-test")
    monkeypatch.delenv("LANGFUSE_HOST", raising=False)
    langfuse_cls, _ = _make_fake_langfuse()

    result = emit_hello_trace(langfuse_factory=langfuse_cls)

    assert result.host == LOCAL_LANGFUSE_HOST
    _, kwargs = langfuse_cls.call_args
    assert kwargs["host"] == LOCAL_LANGFUSE_HOST


def test_raises_when_credentials_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LANGFUSE_PUBLIC_KEY", raising=False)
    monkeypatch.delenv("LANGFUSE_SECRET_KEY", raising=False)
    langfuse_cls, _ = _make_fake_langfuse()

    with pytest.raises(RuntimeError, match="LANGFUSE_PUBLIC_KEY"):
        emit_hello_trace(langfuse_factory=langfuse_cls)

    langfuse_cls.assert_not_called()


def test_default_factory_is_the_real_sdk() -> None:
    """Without injection the function must reach for the real Langfuse client."""
    import owners_manual_evals.hello_trace as mod

    # The module exposes a zero-arg loader so the import stays lazy (SDK import
    # cost / OTel side effects don't happen at module import time).
    factory: Any = mod._default_langfuse_factory
    assert callable(factory)
