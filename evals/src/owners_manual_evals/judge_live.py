"""The live judge binding (issue #18): Claude via the Agent SDK, offline batch.

ADR 0005: the primary judge is Claude (cross-family by default since the product
model is Gemini), billed to the Claude Max Agent SDK credit ($100/month, opened
2026-06-15) which covers ``claude -p`` / Agent SDK usage. The judge is OFFLINE
batch and live-by-design — uninstrumented, like ``live/vertex-agent.ts`` on the TS
side — so it is NOT unit-tested; the judge logic, the prompt, and the JSON parsing
are all covered upstream against the scripted fake (:func:`scripted_judge`).

ADR 0008 settles the invocation route this module once flagged as open: ``claude
-p`` headless (the credit-billed surface, not a pay-per-token API key), ONE item
per call (judging independence), ``--output-format json`` so cost/usage are
captured off the envelope, and a per-item timeout + bounded retry that fails loud
rather than scoring a failed call. The ENVELOPE parsing
(:func:`parse_judge_cli_envelope`) is pure and unit-tested; only the subprocess
call itself stays ``pragma: no cover``. The judge MODEL string is read from config
(env), never hardcoded, matching the no-hardcoded-model-strings rule.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from .golden_item import AnswerPoint
from .judge import JudgeClient, JudgePointVerdict, build_judge_prompt, parse_judge_response

#: Per-item wall-clock budget for one ``claude -p`` judge call (ADR 0008).
JUDGE_TIMEOUT_S = 120.0
#: Attempts per item before failing loud (ADR 0008: bounded retry, then raise).
JUDGE_MAX_ATTEMPTS = 2


@dataclass(frozen=True, slots=True)
class JudgeCliCall:
    """One ``claude -p --output-format json`` call's payload (ADR 0008).

    ``result_text`` is the model's ``result`` field — the verdict JSON still handed
    to :func:`parse_judge_response`; ``total_cost_usd`` and ``usage`` are captured
    off the envelope for the run record. Cost/usage are ``None`` when the CLI omits
    them, never fabricated as 0.
    """

    result_text: str
    total_cost_usd: float | None
    usage: Mapping[str, object] | None


def parse_judge_cli_envelope(stdout: str) -> JudgeCliCall:
    """Parse the ``claude -p --output-format json`` envelope (ADR 0008).

    Extracts the model's ``result`` text (the verdict JSON) and captures
    ``total_cost_usd`` + ``usage``. Raises ``ValueError`` on malformed JSON, an
    error envelope (``is_error``), or a missing / non-string ``result`` — a judge
    that proceeded on a failed CLI call would score garbage.
    """
    try:
        envelope = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise ValueError(f"claude CLI did not return valid JSON: {error}") from error
    if not isinstance(envelope, dict):
        raise ValueError("claude CLI envelope is not a JSON object")
    if envelope.get("is_error"):
        raise ValueError(f"claude CLI reported an error: {envelope.get('result')!r}")
    result = envelope.get("result")
    if not isinstance(result, str):
        raise ValueError("claude CLI envelope has no string 'result' field")
    cost = envelope.get("total_cost_usd")
    usage = envelope.get("usage")
    return JudgeCliCall(
        result_text=result,
        total_cost_usd=float(cost) if isinstance(cost, (int, float)) else None,
        usage=usage if isinstance(usage, Mapping) else None,
    )


def build_claude_judge() -> JudgeClient:  # pragma: no cover - live by design
    """Build the live Claude judge over ``claude -p`` (Agent SDK credit, ADR 0008).

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

    The invocation route is settled in ADR 0008: one ``claude -p`` call per item
    (judging independence), ``--output-format json`` (cost/usage captured via
    :func:`parse_judge_cli_envelope`), a per-item timeout, and a bounded retry that
    fails loud rather than scoring a failed call. Each call's cost/usage is recorded
    in :attr:`calls` for the run record.
    """

    def __init__(
        self,
        *,
        model: str,
        timeout_s: float = JUDGE_TIMEOUT_S,
        max_attempts: int = JUDGE_MAX_ATTEMPTS,
    ) -> None:
        self._model = model
        self._timeout_s = timeout_s
        self._max_attempts = max_attempts
        self._calls: list[JudgeCliCall] = []

    @property
    def calls(self) -> tuple[JudgeCliCall, ...]:
        """The per-item CLI calls made so far, with captured cost/usage."""
        return tuple(self._calls)

    @property
    def total_cost_usd(self) -> float:
        """Total captured ``claude -p`` cost across this judge's calls."""
        return sum(call.total_cost_usd or 0.0 for call in self._calls)

    def judge(
        self,
        *,
        question: str,
        answer_text: str,
        points: Sequence[AnswerPoint],
    ) -> Sequence[JudgePointVerdict]:
        import subprocess  # noqa: PLC0415

        prompt = build_judge_prompt(question=question, answer_text=answer_text, points=points)
        argv = ["claude", "-p", "--model", self._model, "--output-format", "json"]
        last_error: Exception | None = None
        for _attempt in range(self._max_attempts):
            try:
                completed = subprocess.run(  # noqa: S603 — fixed argv, prompt on stdin
                    argv,
                    input=prompt,
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=self._timeout_s,
                )
                call = parse_judge_cli_envelope(completed.stdout)
                verdicts = parse_judge_response(call.result_text, points)
                self._calls.append(call)
                return verdicts
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError) as error:
                last_error = error
        raise RuntimeError(f"claude judge failed after {self._max_attempts} attempts: {last_error}")


__all__ = ["JudgeCliCall", "parse_judge_cli_envelope", "build_claude_judge"]
