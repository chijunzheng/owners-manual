"""owners-manual eval harness.

Phase-0 scaffold placeholder: exists so the uv-managed package, pytest, and
ruff are wired and green before the golden-set loader, citation-accuracy
metrics, RAGAS, and Langfuse integration land in later issues.
"""

PACKAGE_NAME = "owners-manual-evals"


def scaffold_ready() -> bool:
    """Mark that the Python eval-harness scaffold is wired and importable."""
    return True


__all__ = ["PACKAGE_NAME", "scaffold_ready"]
