"""Phase-0 scaffold smoke test for the Python eval harness.

Pins that the uv-managed ``evals`` package is importable and exposes its
identity marker, so pytest is green before the real golden-set loader and
RAGAS/Langfuse wiring land in later issues.
"""

from owners_manual_evals import PACKAGE_NAME, scaffold_ready


def test_package_name() -> None:
    assert PACKAGE_NAME == "owners-manual-evals"


def test_scaffold_ready() -> None:
    assert scaffold_ready() is True
