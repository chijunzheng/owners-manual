"""owners-manual eval harness.

Hosts the Python side of the shared domain (issue #7): the typed document tree,
citable-path addressing, and the hierarchical cite matcher the grader applies to
golden-set required cites — pinned to the same cross-language conformance
vectors the TypeScript core library passes. On top of that sits the golden-item
schema and loader (issue #30): strict YAML item validation, required-cite
resolvability against document trees, deterministic stratified dev/holdout
assignment, and verified-only filtering for eval runs. RAGAS and Langfuse
integration land in later issues.

Submodules (``citable_path``, ``document_tree``, ``cite_matcher``,
``conformance``, ``golden_item``, ``golden_split``, ``golden_loader``,
``golden_fixtures``) are imported directly rather than re-exported here, so
loading the package stays cheap.
"""

PACKAGE_NAME = "owners-manual-evals"


def scaffold_ready() -> bool:
    """Mark that the Python eval-harness scaffold is wired and importable."""
    return True


__all__ = ["PACKAGE_NAME", "scaffold_ready"]
