"""The LLM judge (issue #18): a rubric-anchored BINARY per-answer-point judge.

CONTEXT.md ("Score dashboard", "Calibration slice"): answer-point credit is
judge-scored, and the judge adds a binary per-point score BESIDE the deterministic
metrics (behavior match, cite P/R, strict pass) — it never replaces them. Each
golden answer point is graded credited / not-credited against the produced answer
text; the item's ``point_score`` is the fraction of points credited (the same
"point score" the dashboard publishes), and ``all_points_credited`` is the part of
strict pass the judge owns.

ADR 0005: Claude is the primary judge — cross-family by default since the product
model is Gemini, so self-preference bias has no purchase on headline numbers;
Gemini is the same-family secondary judge on the calibration slice. The judge's
model is injected behind the :class:`JudgeClient` seam, so this module is pure and
unit-tested with a SCRIPTED FAKE (mirroring the agent's scripted-fake-model
convention). The live binding (Claude via the Agent SDK, offline batch) lives in
:mod:`judge_live` and is live-by-design, uninstrumented.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Protocol

from .golden_item import AnswerPoint


@dataclass(frozen=True, slots=True)
class JudgePointVerdict:
    """One rubric point's binary verdict: credited or not, with a short rationale."""

    point_id: str
    credited: bool
    rationale: str = ""


@dataclass(frozen=True, slots=True)
class JudgeResult:
    """The judge's verdict for one item: per-point binary verdicts and the
    fraction of points credited (``point_score``). ``all_points_credited`` is the
    judge's half of strict pass (the cites half is deterministic)."""

    item_id: str
    point_verdicts: tuple[JudgePointVerdict, ...]
    point_score: float
    all_points_credited: bool


class JudgeClient(Protocol):
    """The slice of a judge model this module needs — injectable for tests.

    Returns one :class:`JudgePointVerdict` per supplied answer point (the live
    binding parses the model's JSON into these; the fake returns them directly).
    """

    def judge(
        self,
        *,
        question: str,
        answer_text: str,
        points: Sequence[AnswerPoint],
    ) -> Sequence[JudgePointVerdict]: ...


_JUDGE_INSTRUCTION = (
    "You are grading an answer to an Ontario condo-owner / tenancy question against "
    "a fixed rubric. For EACH rubric point below, return a BINARY verdict: is the "
    "point's claim substantively asserted and supported by the ANSWER text? Credit "
    "a point only when the answer actually makes that claim — not merely the topic. "
    "Return a single JSON object: "
    '{"verdicts": [ { "pointId": ..., "credited": true|false, "rationale": ... } ]}, '
    "with exactly one entry per rubric point and no prose outside the JSON."
)


def build_judge_prompt(
    *,
    question: str,
    answer_text: str,
    points: Sequence[AnswerPoint],
) -> str:
    """Assemble the rubric-anchored binary judge prompt: instruction, the rubric
    points (by id), the question, and the answer under grade."""
    rubric = "\n".join(f"- [{point.id}] {point.text}" for point in points)
    return (
        f"{_JUDGE_INSTRUCTION}\n\n"
        f"RUBRIC POINTS:\n{rubric}\n\n"
        f"QUESTION:\n{question}\n\n"
        f"ANSWER:\n{answer_text}"
    )


def _extract_first_json_object(text: str) -> str | None:
    """Return the first balanced ``{…}`` substring, or ``None`` if there is none.

    A brace scan that respects string literals and escapes, so a verdict object
    wrapped in surrounding prose (or trailing commentary) is still recovered."""
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escape = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return None


def parse_judge_response(text: str, points: Sequence[AnswerPoint]) -> tuple[JudgePointVerdict, ...]:
    """Parse the judge model's JSON into per-point verdicts.

    Raises ``ValueError`` if the JSON is malformed or omits a rubric point — a
    judge that silently drops a point would inflate or deflate the point score.
    """
    body = text.strip()
    if body.startswith("```"):
        # Strip a ```json … ``` fence the model may wrap the object in.
        body = body.strip("`")
        if body.lower().startswith("json"):
            body = body[4:]
        body = body.strip()
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as error:
        # A chat model (e.g. Claude via `claude -p`) may wrap the verdict object
        # in prose ("I'll respond with the requested JSON object.\n\n{…}");
        # fall back to the first balanced {…} object before failing loud.
        extracted = _extract_first_json_object(body)
        if extracted is None:
            raise ValueError(f"judge did not return valid JSON: {error}") from error
        try:
            parsed = json.loads(extracted)
        except json.JSONDecodeError as inner:
            raise ValueError(f"judge did not return valid JSON: {inner}") from inner
    raw_verdicts = parsed.get("verdicts", []) if isinstance(parsed, dict) else []
    by_id: dict[str, JudgePointVerdict] = {}
    for entry in raw_verdicts:
        if not isinstance(entry, dict):
            continue
        point_id = entry.get("pointId")
        if not isinstance(point_id, str):
            continue
        by_id[point_id] = JudgePointVerdict(
            point_id=point_id,
            credited=bool(entry.get("credited", False)),
            rationale=str(entry.get("rationale", "")),
        )
    return _order_and_check(by_id, points)


def _order_and_check(
    by_id: Mapping[str, JudgePointVerdict],
    points: Sequence[AnswerPoint],
) -> tuple[JudgePointVerdict, ...]:
    """Return the verdicts in rubric order, raising if any point is missing."""
    missing = [point.id for point in points if point.id not in by_id]
    if missing:
        raise ValueError(f"judge omitted a verdict for rubric point(s): {missing}")
    return tuple(by_id[point.id] for point in points)


def judge_item(
    item: object,
    *,
    answer_text: str,
    judge_client: JudgeClient,
) -> JudgeResult:
    """Judge one item's answer points binary, BESIDE the deterministic metrics.

    Every rubric point must receive a verdict; a judge that omits one raises
    ``ValueError`` rather than scoring a partial rubric.
    """
    points = item.answer_points  # type: ignore[attr-defined]
    verdicts = _order_and_check(
        {
            v.point_id: v
            for v in judge_client.judge(
                question=item.question,  # type: ignore[attr-defined]
                answer_text=answer_text,
                points=points,
            )
        },
        points,
    )
    credited = sum(1 for v in verdicts if v.credited)
    point_score = credited / len(verdicts) if verdicts else 0.0
    return JudgeResult(
        item_id=item.id,  # type: ignore[attr-defined]
        point_verdicts=verdicts,
        point_score=point_score,
        all_points_credited=credited == len(verdicts) and len(verdicts) > 0,
    )


@dataclass(frozen=True, slots=True)
class _ScriptedJudge:
    """A scripted fake judge: a fixed credited/not map keyed by point id."""

    credited_by_point: Mapping[str, bool]
    rationale: str = field(default="scripted")

    def judge(
        self,
        *,
        question: str,
        answer_text: str,
        points: Sequence[AnswerPoint],
    ) -> Sequence[JudgePointVerdict]:
        _ = (question, answer_text)
        return [
            JudgePointVerdict(
                point_id=point.id,
                credited=bool(self.credited_by_point.get(point.id, False)),
                rationale=self.rationale,
            )
            for point in points
            if point.id in self.credited_by_point
        ]


def scripted_judge(
    credited_by_point: Mapping[str, bool],
    *,
    rationale: str = "scripted",
) -> JudgeClient:
    """Build a scripted fake judge for the unit suite (no live model call).

    Only points present in ``credited_by_point`` get a verdict, so a test can
    exercise the missing-point contract by leaving a point out.
    """
    return _ScriptedJudge(credited_by_point=credited_by_point, rationale=rationale)


@dataclass(frozen=True, slots=True)
class _NoOpJudge:
    """A judge that credits NOTHING but returns a verdict for EVERY supplied point."""

    rationale: str = "no-judge (uncredited)"

    def judge(
        self,
        *,
        question: str,
        answer_text: str,
        points: Sequence[AnswerPoint],
    ) -> Sequence[JudgePointVerdict]:
        _ = (question, answer_text)
        return [
            JudgePointVerdict(point_id=point.id, credited=False, rationale=self.rationale)
            for point in points
        ]


def no_op_judge(*, rationale: str = "no-judge (uncredited)") -> JudgeClient:
    """Build a no-op judge for ``--no-judge``: it credits nothing yet returns one
    verdict per rubric point, so :func:`judge_item` does not raise and the
    point-score column reads 0.0. Unlike an empty :func:`scripted_judge` (which
    omits every point and violates the one-verdict-per-point contract), this is the
    safe fallback before the live judge (Claude via the Agent SDK) is wired."""
    return _NoOpJudge(rationale=rationale)


__all__ = [
    "JudgePointVerdict",
    "JudgeResult",
    "JudgeClient",
    "build_judge_prompt",
    "parse_judge_response",
    "judge_item",
    "scripted_judge",
    "no_op_judge",
]
