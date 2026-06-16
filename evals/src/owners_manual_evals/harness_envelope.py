"""The full-envelope output the harness writes to its OWNED root observation.

In NESTED mode (the live eval-harness path) the Python harness propagates a W3C
``traceparent`` and OWNS the trace, so it owns the ROOT observation
``owners-manual.harness.item``. #48/#49 (the TS half) record the full envelope on
the TS service's child spans, but the TS tracer deliberately never clobbers the
harness-owned root in nested mode (``langfuse-tracer.ts``). So the harness must
write the full envelope to that root itself — otherwise an eval-run trace shows
only ``behaviorClass`` at the top with the answer one level down (issue #50).

The harness holds ``answer_text`` and the parsed candidate cites (claim text is
not retained past parsing — it lives on the TS child span via #48/#49). So the
harness root carries ``behaviorClass`` + ``answer`` + the cites it parsed,
serialized back to the envelope's machine-readable cite wire shape (the same
``{documentId, segments:[{kind, label}]}`` the service emits) — never a lossy
display string. New dicts are built; nothing is mutated.
"""

from __future__ import annotations

from collections.abc import Sequence

from .citable_path import CitablePath


def _cite_to_wire(cite: CitablePath) -> dict:
    """Serialize a :class:`CitablePath` to the envelope's cite wire shape."""
    return {
        "documentId": cite.document_id,
        "segments": [{"kind": seg.kind, "label": seg.label} for seg in cite.segments],
    }


def _claims_from_cites(cites: Sequence[CitablePath]) -> list[dict]:
    """Render the harness's parsed candidate cites as the root's ``claims``.

    Claim-level text is dropped at parse time (only the flattened cites survive on
    the result), so the harness root carries one claim entry per cite it holds —
    machine-readable, on the envelope cite contract — while the full claim text
    lives on the TS child span via #48/#49.
    """
    return [{"cites": [_cite_to_wire(cite)]} for cite in cites]


def build_harness_output(
    *,
    behavior_class: str,
    answer_text: str,
    candidate_cites: Sequence[CitablePath],
    degraded: bool | None = None,
) -> dict:
    """Build the full-envelope ``output`` for the harness-owned root observation.

    Mirrors the trace-root envelope the TS half writes (#48/#49):
    ``{behaviorClass, answer, claims}``, plus ``degraded`` for the agent arm
    (omitted entirely when ``degraded`` is ``None`` so the naive-rag root stays
    exactly the three-key envelope).
    """
    output: dict = {
        "behaviorClass": behavior_class,
        "answer": answer_text,
        "claims": _claims_from_cites(candidate_cites),
    }
    if degraded is not None:
        return {**output, "degraded": degraded}
    return output


__all__ = ["build_harness_output"]
