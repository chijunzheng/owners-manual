"""Unit tests for the PURE parts of the live judge binding (issue #45, ADR 0008).

The ``claude -p`` subprocess call is live-by-design (``pragma: no cover``); the
``--output-format json`` ENVELOPE parsing — which captures cost/usage and yields
the verdict text handed to ``parse_judge_response`` — is pure and tested here.
"""

from __future__ import annotations

import json

import pytest

from owners_manual_evals.judge_live import JudgeCliCall, parse_judge_cli_envelope


def _envelope(**overrides: object) -> str:
    base: dict[str, object] = {
        "type": "result",
        "is_error": False,
        "result": '{"verdicts": []}',
        "total_cost_usd": 0.0123,
        "usage": {"input_tokens": 10, "output_tokens": 5},
    }
    base.update(overrides)
    return json.dumps(base)


def test_parses_result_text_and_captures_cost_and_usage() -> None:
    call = parse_judge_cli_envelope(_envelope())
    assert isinstance(call, JudgeCliCall)
    assert call.result_text == '{"verdicts": []}'
    assert call.total_cost_usd == pytest.approx(0.0123)
    assert call.usage == {"input_tokens": 10, "output_tokens": 5}


def test_missing_cost_or_usage_is_none_not_an_error() -> None:
    call = parse_judge_cli_envelope(json.dumps({"result": '{"verdicts": []}', "is_error": False}))
    assert call.result_text == '{"verdicts": []}'
    assert call.total_cost_usd is None
    assert call.usage is None


def test_malformed_json_raises() -> None:
    with pytest.raises(ValueError, match="valid JSON"):
        parse_judge_cli_envelope("not json at all")


def test_error_envelope_raises() -> None:
    with pytest.raises(ValueError, match="error"):
        parse_judge_cli_envelope(_envelope(is_error=True, result="rate limited"))


def test_missing_result_field_raises() -> None:
    with pytest.raises(ValueError, match="result"):
        parse_judge_cli_envelope(json.dumps({"is_error": False, "total_cost_usd": 0.01}))


def test_non_object_envelope_raises() -> None:
    # `claude -p --output-format json` always returns a JSON OBJECT; a parsed
    # array (or any other non-object) is rejected, never silently mis-read.
    with pytest.raises(ValueError, match="JSON object"):
        parse_judge_cli_envelope(json.dumps(["not", "an", "object"]))
