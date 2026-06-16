"""The full-envelope output the harness writes to its OWNED root observation.

In NESTED mode (the live eval-harness path) the Python harness propagates a W3C
``traceparent`` and OWNS the trace, so it owns the ROOT observation
``owners-manual.harness.item``. #48/#49 (the TS half) record the full envelope on
the TS service's child spans, but the TS tracer deliberately never clobbers the
harness-owned root in nested mode (``langfuse-tracer.ts``). So the harness must
write the full envelope to that root itself — otherwise an eval-run trace shows
only ``behaviorClass`` at the top with the answer one level down (issue #50).

The harness holds the parsed answer envelope — ``answer_text`` plus the typed
claims (text + cites) the client retains (#50). So the harness root carries the
full envelope ``{behaviorClass, answer, claims}`` (+ ``degraded`` for the agent),
each claim serialized to the envelope's wire shape — ``text`` plus
``{documentId, segments:[{kind, label}]}`` cites — mirroring exactly what the
service emitted, never flattened or textless. New dicts are built; nothing is
mutated.
"""

from __future__ import annotations

from collections.abc import Sequence

from .answer_claim import AnswerClaim
from .citable_path import CitablePath


def _cite_to_wire(cite: CitablePath) -> dict:
    """Serialize a :class:`CitablePath` to the envelope's cite wire shape."""
    return {
        "documentId": cite.document_id,
        "segments": [{"kind": seg.kind, "label": seg.label} for seg in cite.segments],
    }


def _claim_to_wire(claim: AnswerClaim) -> dict:
    """Serialize one :class:`AnswerClaim` to the envelope's claim wire shape —
    ``{text, cites}`` (the shared ``answerClaimSchema``), grouping preserved."""
    return {
        "text": claim.text,
        "cites": [_cite_to_wire(cite) for cite in claim.cites],
    }


def build_harness_output(
    *,
    behavior_class: str,
    answer_text: str,
    claims: Sequence[AnswerClaim],
    degraded: bool | None = None,
) -> dict:
    """Build the full-envelope ``output`` for the harness-owned root observation.

    Mirrors the trace-root envelope the TS half writes (#48/#49):
    ``{behaviorClass, answer, claims}`` with each claim carrying ``text`` AND its
    ``cites`` (the shared ``answerClaimSchema``), plus ``degraded`` for the agent
    arm (omitted entirely when ``degraded`` is ``None`` so the naive-rag root
    stays exactly the three-key envelope). Refusals carry an empty ``claims`` list.
    """
    output: dict = {
        "behaviorClass": behavior_class,
        "answer": answer_text,
        "claims": [_claim_to_wire(claim) for claim in claims],
    }
    if degraded is not None:
        return {**output, "degraded": degraded}
    return output


__all__ = ["build_harness_output"]
