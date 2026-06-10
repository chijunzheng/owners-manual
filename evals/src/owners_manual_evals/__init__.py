"""owners-manual eval harness.

Hosts the Python side of the shared domain (issue #7): the typed document tree,
citable-path addressing, and the hierarchical cite matcher the grader applies to
golden-set required cites — pinned to the same cross-language conformance
vectors the TypeScript core library passes. The golden-set loader, RAGAS, and
Langfuse integration land in later issues.

Submodules (``citable_path``, ``document_tree``, ``cite_matcher``,
``conformance``) are imported directly rather than re-exported here, so loading
the package stays cheap.
"""

PACKAGE_NAME = "owners-manual-evals"


def scaffold_ready() -> bool:
    """Mark that the Python eval-harness scaffold is wired and importable."""
    return True


__all__ = ["PACKAGE_NAME", "scaffold_ready"]
