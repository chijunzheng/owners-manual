"""The live SECONDARY judge binding: Gemini on Vertex (issue #19, ADR 0010 Decision 6).

ADR 0005 reserves Gemini as the same-family SECONDARY judge for the calibration
slice; ADR 0010 Decision 6 runs it over the SAME agent-arm answers as Claude so the
three judge-judge κ can be published (Gemini is diagnostic only, never averaged into
the headline). This is the thin live binding behind the :class:`~.judge.JudgeClient`
seam — live-by-design and NOT unit-tested, exactly like :mod:`judge_live` (Claude)
and :mod:`ragas_live`: the prompt (:func:`judge.build_judge_prompt`) and the JSON
parsing (:func:`judge.parse_judge_response`) are reused verbatim and are covered
upstream against the scripted fake (:func:`judge.scripted_judge`).

The provider is the SAME Gemini-on-Vertex client the product and RAGAS use (ADR
0005): ``ChatVertexAI`` from ``langchain-google-vertexai``, imported lazily (the
heavy/optional ``ragas`` dependency group ships it) so importing this module never
requires the SDK and the offline suite's dependency surface is untouched. The judge
MODEL string is read from a dedicated env var (fail loud if unset), mirroring ADR
0008's ``JUDGE_CLAUDE_MODEL`` and ADR 0009's ``RAGAS_VERTEX_MODEL`` — never hardcoded.
"""

from __future__ import annotations

import os
from collections.abc import Sequence

from .golden_item import AnswerPoint
from .judge import JudgeClient, JudgePointVerdict, build_judge_prompt, parse_judge_response

#: The Vertex model string for the Gemini secondary judge, read from the environment
#: (ADR 0010 Decision 6). MAY be the product model but is pinned independently —
#: never hardcoded, mirroring ``JUDGE_CLAUDE_MODEL`` (ADR 0008).
JUDGE_GEMINI_MODEL_ENV = "JUDGE_GEMINI_MODEL"


def build_gemini_judge() -> JudgeClient:  # pragma: no cover - live by design
    """Build the live Gemini secondary judge over Vertex (ADR 0005 / 0010 Decision 6).

    Raises ``RuntimeError`` with a clear message if ``JUDGE_GEMINI_MODEL`` is unset
    (fail loud at the start of a run, not score garbage) or if
    ``langchain-google-vertexai`` is not installed (the optional ``ragas`` group ships
    it; the offline suite mocks the judge seam and needs neither).
    """
    model = os.environ.get(JUDGE_GEMINI_MODEL_ENV)
    if not model:
        raise RuntimeError(
            f"{JUDGE_GEMINI_MODEL_ENV} is not set. Pin the Gemini secondary-judge model in "
            ".env (the same-family diagnostic judge, ADR 0005 / 0010 Decision 6) before "
            "running calibration; tests mock the judge seam."
        )
    try:
        from langchain_google_vertexai import ChatVertexAI  # noqa: PLC0415
    except ImportError as error:
        raise RuntimeError(
            "langchain-google-vertexai is not installed. Install the evals 'ragas' optional "
            "dependency group (e.g. `uv sync --group ragas`, which ships the Vertex client) "
            "before running the Gemini secondary judge; the offline unit suite mocks the "
            "judge seam and needs neither."
        ) from error
    return _GeminiJudge(model=ChatVertexAI(model=model))


class _GeminiJudge:  # pragma: no cover - live by design
    """A :class:`JudgeClient` backed by the Gemini-on-Vertex chat model.

    Per item it assembles the SAME rubric-anchored binary prompt Claude uses
    (:func:`build_judge_prompt`) and parses the model's reply with the SAME strict
    parser (:func:`parse_judge_response`), so the secondary judge grades an identical
    construct — the judge-judge κ is meaningful. One invocation per item preserves
    per-item independence (as Claude's one-call-per-item does).
    """

    def __init__(self, *, model: object) -> None:
        self._model = model

    def judge(
        self,
        *,
        question: str,
        answer_text: str,
        points: Sequence[AnswerPoint],
    ) -> Sequence[JudgePointVerdict]:
        prompt = build_judge_prompt(question=question, answer_text=answer_text, points=points)
        response = self._model.invoke(prompt)  # type: ignore[attr-defined]
        text = getattr(response, "content", response)
        return parse_judge_response(str(text), points)


__all__ = ["JUDGE_GEMINI_MODEL_ENV", "build_gemini_judge"]
