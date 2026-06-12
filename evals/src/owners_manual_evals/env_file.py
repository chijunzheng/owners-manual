"""Repo-root ``.env`` loading for the live CLI (issue #10).

The TS CLIs load the gitignored root ``.env`` themselves (Node's
``process.loadEnvFile``); this is the Python mirror, so the documented
one-command run (``uv run run-naive-rag``) works without the caller exporting
the env first. Existing process environment always wins — the file only fills
gaps, matching dotenv convention. Values are never logged.
"""

from __future__ import annotations

import os
from collections.abc import MutableMapping
from pathlib import Path

#: The committed contract file that marks the repo root.
_ROOT_MARKER = ".env.example"


def resolve_root_env_path() -> Path | None:
    """Locate ``<repo-root>/.env`` by walking up to the ``.env.example`` marker.

    Returns the ``.env`` path (which may not exist yet) or ``None`` when no
    ancestor carries the marker (e.g. the package is installed outside the
    repo).
    """
    for ancestor in Path(__file__).resolve().parents:
        if (ancestor / _ROOT_MARKER).is_file():
            return ancestor / ".env"
    return None


def load_env_file(
    path: Path,
    *,
    environ: MutableMapping[str, str] = os.environ,
) -> int:
    """Load ``KEY=VALUE`` lines from ``path`` into ``environ``.

    Skips comments, blank lines, and lines without ``=``. Strips whitespace and
    one layer of matching quotes from values. NEVER overrides keys already
    present in ``environ``. Returns the number of keys set; a missing file is a
    no-op returning 0.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return 0

    loaded = 0
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, raw_value = line.partition("=")
        key = key.strip()
        value = raw_value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        if not key or key in environ:
            continue
        environ[key] = value
        loaded += 1
    return loaded


def load_root_env(*, environ: MutableMapping[str, str] = os.environ) -> int:
    """Load the repo-root ``.env`` if it exists; existing env vars win."""
    path = resolve_root_env_path()
    return load_env_file(path, environ=environ) if path is not None else 0


__all__ = ["load_env_file", "load_root_env", "resolve_root_env_path"]
