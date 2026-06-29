"""Strict ``corrections.yaml`` parser for ``calibrate triage`` (issue #19, ADR 0010
Decision 4).

The triage corrections are a committed, hand-authored artifact: one row per
judge↔human mismatch, naming its bucket and — for a relabel — the corrected human
credit. This module is the PURE, strict parser (the ``golden_item.py`` /
``parse_labels`` reject-don't-coerce philosophy), enforcing the HONEST-DEFAULT
discipline of Decision 4 at load time rather than trusting the author:

* unknown top-level or per-row keys are rejected (a smuggled field never coerces);
* ``bucket`` must be one of the three triage buckets (``rubric-wrong`` /
  ``human-error`` / ``judge-error``);
* ``justification`` is REQUIRED, non-empty, for EVERY correction — the written-
  justification discipline (a relabel, or even a judge-error call, without a stated
  reason is rejected, so every correction carries its rationale in the artifact);
* ``corrected_human_credited`` is REQUIRED (a JSON bool) for the relabel buckets and
  FORBIDDEN for ``judge-error`` — mirroring
  :func:`calibration_triage._validate_correction`, so the judge's frozen verdict can
  never be silently flipped through the file.

The parser yields :class:`calibration_triage.Correction` objects, so the parsed
output drops straight into :func:`calibration_triage.triage_and_recompute`. The
``justification`` is enforced here (the discipline lives at the artifact boundary)
and surfaced by the CLI; it is not a field on the pure :class:`Correction` value.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import get_args

from .calibration_triage import _RELABEL_BUCKETS, Correction, TriageBucket

#: The triage buckets a corrections row may name, derived from the single source of
#: truth (the :data:`~.calibration_triage.TriageBucket` literal) so the parser can
#: never drift from the buckets the triage driver accepts (ADR 0010 Decision 4).
_BUCKETS: frozenset[str] = frozenset(get_args(TriageBucket))

#: The keys a corrections row may carry; reject anything else (strict).
_ROW_KEYS = frozenset(
    {"item_id", "point_id", "bucket", "justification", "corrected_human_credited"}
)

#: The keys the corrections document may carry at the top level.
_DOC_KEYS = frozenset({"corrections"})


@dataclass(frozen=True, slots=True)
class ParsedCorrection:
    """A parsed corrections row: the pure :class:`Correction` the triage driver
    consumes, paired with the WRITTEN ``justification`` the file required (surfaced
    by the CLI alongside the recompute, the discipline's audit trail). The
    justification is deliberately NOT a field on :class:`Correction` — the triage
    math never needs it; it lives only in the artifact and the printed report."""

    correction: Correction
    justification: str


def parse_corrections(text: str) -> tuple[Correction, ...]:
    """Parse a ``corrections.yaml`` into :class:`Correction` objects, strictly.

    Enforces the Decision-4 discipline at load time (see the module docstring):
    a known bucket, a non-empty justification on EVERY row, and the relabel ⇄ bucket
    coupling (``corrected_human_credited`` required for a relabel, forbidden for
    ``judge-error``). Raises ``ValueError`` on any violation; never mutates its input.
    An empty (but present) ``corrections`` list is valid — a run with no mismatches
    needs no corrections — and parses to an empty tuple.
    """
    return tuple(parsed.correction for parsed in parse_corrections_with_justifications(text))


def parse_corrections_with_justifications(text: str) -> tuple[ParsedCorrection, ...]:
    """Like :func:`parse_corrections` but keep each row's WRITTEN justification.

    The CLI prints the justifications beside the per-bucket counts (the written-
    justification discipline's audit trail), so it parses with this richer return;
    the pure triage math only ever needs the bare :class:`Correction` tuple.
    """
    import yaml  # noqa: PLC0415

    raw = yaml.safe_load(text)
    if not isinstance(raw, dict):
        raise ValueError("corrections file must be a mapping")
    unknown = set(raw) - _DOC_KEYS
    if unknown:
        raise ValueError(f"corrections file has unknown keys: {sorted(unknown)}")

    raw_rows = raw.get("corrections")
    if not isinstance(raw_rows, list):
        raise ValueError("corrections file requires a corrections list (may be empty)")

    return tuple(_parse_row(entry) for entry in raw_rows)


def _parse_row(entry: object) -> ParsedCorrection:
    if not isinstance(entry, dict):
        raise ValueError("corrections row must be a mapping")
    unknown = set(entry) - _ROW_KEYS
    if unknown:
        raise ValueError(f"corrections row has unknown keys: {sorted(unknown)}")

    item_id = _require_nonempty_str(entry, "item_id")
    point_id = _require_nonempty_str(entry, "point_id")
    bucket = _parse_bucket(entry, item_id=item_id, point_id=point_id)
    _require_nonempty_str(
        entry,
        "justification",
        hint=(
            f"corrections row {item_id!r}/{point_id!r} requires a non-empty justification "
            "(the written-justification discipline applies to EVERY correction, ADR 0010 "
            "Decision 4)"
        ),
    )
    corrected = _parse_corrected_human_credited(
        entry, bucket=bucket, item_id=item_id, point_id=point_id
    )

    return ParsedCorrection(
        correction=Correction(
            item_id=item_id,
            point_id=point_id,
            bucket=bucket,
            corrected_human_credited=corrected,
        ),
        justification=str(entry["justification"]),
    )


def _parse_bucket(entry: Mapping[str, object], *, item_id: str, point_id: str) -> TriageBucket:
    bucket = entry.get("bucket")
    if bucket not in _BUCKETS:
        raise ValueError(
            f"corrections row {item_id!r}/{point_id!r} has unknown bucket {bucket!r}; "
            f"expected one of {sorted(_BUCKETS)} (ADR 0010 Decision 4)"
        )
    return bucket  # type: ignore[return-value]


def _parse_corrected_human_credited(
    entry: Mapping[str, object],
    *,
    bucket: str,
    item_id: str,
    point_id: str,
) -> bool | None:
    """Enforce the relabel ⇄ bucket coupling (mirrors ``_validate_correction``):
    a relabel bucket REQUIRES a bool ``corrected_human_credited``; ``judge-error``
    FORBIDS one (it never relabels, so the judge can never be flipped via the file).
    """
    has_key = "corrected_human_credited" in entry
    value = entry.get("corrected_human_credited")

    if bucket in _RELABEL_BUCKETS:
        if not has_key:
            raise ValueError(
                f"{bucket} correction for {item_id!r}/{point_id!r} requires a boolean "
                "corrected_human_credited (a relabel must state the corrected credit)"
            )
        if not isinstance(value, bool):
            raise ValueError(
                f"{bucket} correction for {item_id!r}/{point_id!r} requires a JSON boolean "
                f"corrected_human_credited (got {value!r}); reject rather than coerce"
            )
        return value

    if has_key:
        raise ValueError(
            f"judge-error correction for {item_id!r}/{point_id!r} may not carry a "
            "corrected_human_credited (a judge-error never relabels — Decision 4)"
        )
    return None


def _require_nonempty_str(entry: Mapping[str, object], key: str, *, hint: str | None = None) -> str:
    found = entry.get(key)
    if not isinstance(found, str) or not found.strip():
        raise ValueError(hint or f"corrections row {key!r} must be a non-empty string")
    return found


__all__ = [
    "ParsedCorrection",
    "parse_corrections",
    "parse_corrections_with_justifications",
]
