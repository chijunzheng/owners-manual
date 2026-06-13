"""Tests for the repo-root .env loader the live CLI uses (issue #10).

The TS CLIs load the root .env themselves (process.loadEnvFile); the Python
entry point must match, or the documented one-command run fails unless the
caller remembers to export the env first.
"""

from pathlib import Path

from owners_manual_evals.env_file import load_env_file, resolve_root_env_path


def test_loads_key_value_pairs(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("ALPHA=1\nBETA=two\n", encoding="utf-8")
    environ: dict[str, str] = {}

    loaded = load_env_file(env_file, environ=environ)

    assert loaded == 2
    assert environ == {"ALPHA": "1", "BETA": "two"}


def test_skips_comments_blanks_and_malformed_lines(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("# comment\n\nNOEQUALS\nGAMMA=3\n  # indented comment\n", encoding="utf-8")
    environ: dict[str, str] = {}

    loaded = load_env_file(env_file, environ=environ)

    assert loaded == 1
    assert environ == {"GAMMA": "3"}


def test_never_overrides_existing_environment(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("LANGFUSE_HOST=http://from-file\n", encoding="utf-8")
    environ = {"LANGFUSE_HOST": "http://already-set"}

    loaded = load_env_file(env_file, environ=environ)

    assert loaded == 0
    assert environ["LANGFUSE_HOST"] == "http://already-set"


def test_strips_optional_quotes_and_whitespace(tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("DELTA = \"quoted\" \nEPSILON='single'\n", encoding="utf-8")
    environ: dict[str, str] = {}

    load_env_file(env_file, environ=environ)

    assert environ == {"DELTA": "quoted", "EPSILON": "single"}


def test_missing_file_is_a_noop(tmp_path: Path) -> None:
    environ: dict[str, str] = {}
    assert load_env_file(tmp_path / "absent.env", environ=environ) == 0
    assert environ == {}


def test_resolve_root_env_path_finds_the_repo_root_marker() -> None:
    # The repo root is identified by the committed .env.example contract file.
    path = resolve_root_env_path()
    assert path is not None
    assert path.name == ".env"
    assert (path.parent / ".env.example").is_file()
