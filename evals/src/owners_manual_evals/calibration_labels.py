"""Blind labeling-sheet generator + strict loader (issue #19, ADR 0010 Decision 5).

The committed human labels are the #19 deliverable. ADR 0010 Decision 5 pins the
artifact: one row per (item, point) carrying the QUESTION + the agent-arm ANSWER +
the POINT TEXT + a blank ``human_credited`` — and, crucially, **no judge verdict or
rationale**. Blinding is load-bearing: if the human sees the judge's verdict while
labeling, the κ that :mod:`calibration` later computes measures suggestibility, not
agreement (Decision 5; the rejected "show the verdict for context" alternative).

This module owns the PURE side — no Langfuse, no live judge:

* :func:`build_labeling_sheet` — turn a :class:`~.golden_item.GoldenItem` and the
  produced answer text into blind :class:`LabelRow`\\ s (``human_credited`` unset);
* :func:`render_labeling_sheet` — emit ``labels.yaml`` for a human to fill in place.
  Its header comment carries the judge's VERBATIM credit rule, sliced live from
  :data:`judge._JUDGE_INSTRUCTION` (the build's decision 2), so the human grades the
  SAME construct the judge does — sharing the rule is not a blinding violation; only
  the judge's per-item verdict/rationale stays hidden. Deriving it from the live
  instruction is a drift guard: a change to the judge's rule forces the sheet to
  follow, so the two can never silently diverge;
* :func:`parse_labels` — read the filled sheet back, strictly (the
  ``golden_item.py`` philosophy): every row must carry a BOOLEAN decision, and an
  unknown key — e.g. a judge verdict pasted in — is rejected, never coerced. The
  strict parser doubles as a blinding backstop on the way back in.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .golden_item import GoldenItem
from .judge import _JUDGE_INSTRUCTION

#: The keys a labeling-sheet row may carry. ``human_credited`` is the ONLY
#: credited-bearing field; no ``judge``/``verdict``/``rationale``/pre-filled
#: ``credited`` may appear — that closed set is the blinding contract (Decision 5).
_ROW_KEYS = frozenset({"item_id", "point_id", "question", "answer", "point_text", "human_credited"})


def _credit_criterion() -> str:
    """The judge's VERBATIM credit rule, sliced live from :data:`judge._JUDGE_INSTRUCTION`.

    The blind sheet states the SAME construct the judge grades, so the human grades
    the same thing (the build's decision 2 — not a blinding violation: only the
    per-item verdict/rationale stays hidden). Deriving the sentence from the live
    judge instruction — rather than hardcoding a copy — is the drift guard: a future
    edit to the judge's credit rule forces the sheet to follow, so the two can never
    silently diverge. The slice is the credit-rule sentence only (it carries neither
    "verdict" nor "rationale" vocabulary, so blinding of the per-item verdict holds).
    Raises ``ValueError`` if the anchors are ever removed from the instruction — the
    sheet must not ship a stale or empty criterion.
    """
    start = _JUDGE_INSTRUCTION.find("Credit a point only")
    end = _JUDGE_INSTRUCTION.find("not merely the topic.")
    if start < 0 or end < 0:
        raise ValueError(
            "could not locate the judge's credit rule in _JUDGE_INSTRUCTION; the blind "
            "sheet's shared criterion is derived from it and must not drift (ADR 0010)"
        )
    return _JUDGE_INSTRUCTION[start : end + len("not merely the topic.")]


@dataclass(frozen=True, slots=True)
class LabelRow:
    """One blind grading row: what the human reads (question + answer + point text)
    and the single decision they make (``human_credited``). ``human_credited`` is
    ``None`` on a freshly generated sheet — blank until the human grades the point —
    and a real ``bool`` once :func:`parse_labels` reads the filled sheet back."""

    item_id: str
    point_id: str
    question: str
    answer: str
    point_text: str
    human_credited: bool | None = None


def build_labeling_sheet(item: GoldenItem, *, answer_text: str) -> tuple[LabelRow, ...]:
    """Build one blind :class:`LabelRow` per rubric point of ``item``.

    The row carries the question, the produced ``answer_text`` (what the human
    grades against), and the point's claim text. ``human_credited`` is left blank;
    NO judge verdict is attached — the sheet is blind by construction (Decision 5).
    """
    return tuple(
        LabelRow(
            item_id=item.id,
            point_id=point.id,
            question=item.question,
            answer=answer_text,
            point_text=point.text,
        )
        for point in item.answer_points
    )


def render_labeling_sheet(rows: Sequence[LabelRow]) -> str:
    """Render the blind labeling sheet as YAML for a human to fill in place.

    Each row emits exactly the closed key set, with ``human_credited`` null (blank).
    No judge field is ever written — the render is the artifact the blinding guard
    asserts is verdict-free.
    """
    import yaml  # noqa: PLC0415

    document = {
        "labels": [
            {
                "item_id": row.item_id,
                "point_id": row.point_id,
                "question": row.question,
                "answer": row.answer,
                "point_text": row.point_text,
                "human_credited": row.human_credited,  # None on a blank sheet
            }
            for row in rows
        ]
    }
    header = (
        "# Blind human labels for the judge-calibration slice (issue #19, ADR 0010).\n"
        "#\n"
        "# Grade each point: set `human_credited` to true or false against the ANSWER\n"
        "# above it. Do NOT consult the judge's grade — blinding is load-bearing\n"
        "# (Decision 5): a sighted label measures suggestibility, not agreement.\n"
        "#\n"
        "# Apply the SAME credit criterion the judge applies, so judge–human κ measures\n"
        "# agreement on one shared construct (not two different rubrics):\n"
        f"#   {_credit_criterion()}\n"
        "# (Verbatim from the judge instruction; only the judge's per-item grade is\n"
        "# hidden — the rule it grades by is shared on purpose.)\n"
    )
    return header + yaml.safe_dump(document, sort_keys=False, allow_unicode=True)


def parse_labels(text: str) -> tuple[LabelRow, ...]:
    """Parse a FILLED labeling sheet, strictly.

    Every row must carry a BOOLEAN ``human_credited`` (an unfilled ``null`` or a
    non-bool like ``"yes"`` is rejected — the human must decide each point), and any
    unknown key is rejected rather than coerced (a smuggled judge verdict can never
    enter the κ inputs). Raises ``ValueError`` on any violation; never mutates input.
    """
    import yaml  # noqa: PLC0415

    raw = yaml.safe_load(text)
    if not isinstance(raw, dict):
        raise ValueError("labels sheet must be a mapping")
    if set(raw) - {"labels"}:
        raise ValueError(f"labels sheet has unknown keys: {sorted(set(raw) - {'labels'})}")

    raw_rows = raw.get("labels")
    if not isinstance(raw_rows, list) or not raw_rows:
        raise ValueError("labels sheet requires a non-empty labels list")

    return tuple(_parse_row(entry) for entry in raw_rows)


def _parse_row(entry: object) -> LabelRow:
    if not isinstance(entry, dict):
        raise ValueError("labels row must be a mapping")
    unknown = set(entry) - _ROW_KEYS
    if unknown:
        raise ValueError(f"labels row has unknown keys: {sorted(unknown)}")

    item_id = _require_nonempty_str(entry, "item_id")
    point_id = _require_nonempty_str(entry, "point_id")
    question = _require_nonempty_str(entry, "question")
    answer = _require_nonempty_str(entry, "answer")
    point_text = _require_nonempty_str(entry, "point_text")

    human_credited = entry.get("human_credited")
    if not isinstance(human_credited, bool):
        raise ValueError(
            f"labels row {item_id!r}/{point_id!r} requires a boolean human_credited "
            f"(got {human_credited!r}); every point must be graded true or false"
        )

    return LabelRow(
        item_id=item_id,
        point_id=point_id,
        question=question,
        answer=answer,
        point_text=point_text,
        human_credited=human_credited,
    )


def _require_nonempty_str(entry: dict, key: str) -> str:
    found = entry.get(key)
    if not isinstance(found, str) or not found.strip():
        raise ValueError(f"labels row {key!r} must be a non-empty string")
    return found


__all__ = [
    "LabelRow",
    "build_labeling_sheet",
    "render_labeling_sheet",
    "parse_labels",
]
