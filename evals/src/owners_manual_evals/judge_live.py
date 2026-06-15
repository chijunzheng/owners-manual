"""The live judge binding (issue #18): Claude via the Agent SDK, offline batch.

ADR 0005: the primary judge is Claude (cross-family by default since the product
model is Gemini), billed to the Claude Max Agent SDK credit ($100/month, opened
2026-06-15) which covers ``claude -p`` / Agent SDK usage. The judge is OFFLINE
batch and live-by-design — uninstrumented, like ``live/vertex-agent.ts`` on the TS
side — so it is NOT unit-tested; the judge logic, the prompt, and the JSON parsing
are all covered upstream against the scripted fake (:func:`scripted_judge`).

OPEN QUESTION (surfaced to the orchestrator, not hardcoded): the EXACT Agent-SDK
invocation route for the judge is not yet pinned in an ADR — ``claude -p`` one-shot
per item vs the streaming SDK with a batched system prompt vs a Messages-style
call. ADR 0005 names "``claude -p`` / Agent SDK" without fixing the wire. This
module implements the seam (:class:`JudgeClient`) and a ``claude -p`` subprocess
default behind it, but the route is provisional: it should be settled in an ADR
before the nightly judge tier goes live. The judge MODEL string is read from config
(env), never hardcoded, matching the no-hardcoded-model-strings rule.
"""

from __future__ import annotations

import os
from collections.abc import Sequence

from .golden_item import AnswerPoint
from .judge import JudgeClient, JudgePointVerdict, build_judge_prompt, parse_judge_response


def build_claude_judge() -> JudgeClient:  # pragma: no cover - live by design
    """Build the live Claude judge over ``claude -p`` (Agent SDK credit).

    Raises ``RuntimeError`` with a clear message if the judge model is not
    configured, rather than silently falling back — a misconfigured judge should
    fail loud at the start of a run, not score garbage.
    """
    model = os.environ.get("JUDGE_CLAUDE_MODEL")
    if not model:
        raise RuntimeError(
            "JUDGE_CLAUDE_MODEL is not set. Pin the judge model in .env (e.g. a stable "
            "Claude flagship) before running the live judge; tests mock the judge seam."
        )
    return _ClaudeCliJudge(model=model)


class _ClaudeCliJudge:  # pragma: no cover - live by design
    """A :class:`JudgeClient` backed by ``claude -p`` one-shot subprocess calls.

    Provisional invocation route (see module OPEN QUESTION): one ``claude -p`` call
    per item, prompt on stdin, the model's JSON object on stdout, parsed by
    :func:`parse_judge_response`. The SDK-batched alternative is left for the ADR
    that settles the route.
    """

    def __init__(self, *, model: str) -> None:
        self._model = model

    def judge(
        self,
        *,
        question: str,
        answer_text: str,
        points: Sequence[AnswerPoint],
    ) -> Sequence[JudgePointVerdict]:
        import subprocess  # noqa: PLC0415

        prompt = build_judge_prompt(question=question, answer_text=answer_text, points=points)
        completed = subprocess.run(  # noqa: S603 — fixed argv, prompt on stdin
            ["claude", "-p", "--model", self._model, "--output-format", "text"],
            input=prompt,
            capture_output=True,
            text=True,
            check=True,
        )
        return parse_judge_response(completed.stdout, points)


__all__ = ["build_claude_judge"]
