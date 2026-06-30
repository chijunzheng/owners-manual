"""LLM-judge tests (issue #18): the rubric-anchored BINARY per-answer-point judge.

The judge is an OFFLINE component that grades each golden answer point as credited
or not against the produced answer text. It runs BESIDE the deterministic metrics,
never replacing them. The judge's model client is injected behind a seam, so these
tests use a SCRIPTED FAKE judge — never a live Claude/Gemini call (mirrors the
agent's scripted-fake-model convention from #15).
"""

from __future__ import annotations

import pytest

from owners_manual_evals.golden_item import parse_golden_item
from owners_manual_evals.judge import (
    JudgePointVerdict,
    build_judge_prompt,
    judge_item,
    no_op_judge,
    parse_judge_response,
    scripted_judge,
)


def _item(item_id: str = "answer-1") -> object:
    return parse_golden_item(
        {
            "id": item_id,
            "behavior_class": "answer",
            "corpus": "tenancy",
            "verified": True,
            "question": "Who repairs the unit?",
            "answer_points": [
                {"id": "duty", "text": "The landlord must keep the unit in repair."},
                {"id": "covers-unit", "text": "The duty covers the rental unit itself."},
            ],
            "required_cites": [],
            "provenance": {"source": "statute", "reference": "x"},
        },
        documents=(),
    )


def test_build_judge_prompt_anchors_on_the_rubric_points_and_the_answer() -> None:
    prompt = build_judge_prompt(
        question="Who repairs the unit?",
        answer_text="The landlord must keep the unit in repair, including the unit itself.",
        points=_item().answer_points,  # type: ignore[attr-defined]
    )
    # The prompt names each rubric point id and instructs a binary verdict.
    assert "duty" in prompt
    assert "covers-unit" in prompt
    assert "Who repairs the unit?" in prompt
    assert "binary" in prompt.lower() or "credited" in prompt.lower()


def _two_point_verdict_json() -> str:
    return (
        '{"verdicts": ['
        '{"pointId": "duty", "credited": true, "rationale": "asserted"}, '
        '{"pointId": "covers-unit", "credited": false, "rationale": "absent"}]}'
    )


def test_parse_judge_response_reads_a_clean_json_object() -> None:
    verdicts = parse_judge_response(_two_point_verdict_json(), _item().answer_points)  # type: ignore[attr-defined]
    assert {v.point_id: v.credited for v in verdicts} == {"duty": True, "covers-unit": False}


def test_parse_judge_response_strips_a_json_code_fence() -> None:
    fenced = "```json\n" + _two_point_verdict_json() + "\n```"
    verdicts = parse_judge_response(fenced, _item().answer_points)  # type: ignore[attr-defined]
    assert {v.point_id: v.credited for v in verdicts} == {"duty": True, "covers-unit": False}


def test_parse_judge_response_recovers_an_object_wrapped_in_prose() -> None:
    # `claude -p` (Opus) may prepend prose before the JSON despite the instruction;
    # the balanced-brace scan recovers the verdict object rather than failing loud.
    wrapped = "I'll respond with the requested JSON object.\n\n" + _two_point_verdict_json()
    verdicts = parse_judge_response(wrapped, _item().answer_points)  # type: ignore[attr-defined]
    assert {v.point_id: v.credited for v in verdicts} == {"duty": True, "covers-unit": False}


def test_parse_judge_response_recovers_an_object_with_trailing_prose() -> None:
    trailed = _two_point_verdict_json() + "\n\nLet me know if you need anything else."
    verdicts = parse_judge_response(trailed, _item().answer_points)  # type: ignore[attr-defined]
    assert {v.point_id: v.credited for v in verdicts} == {"duty": True, "covers-unit": False}


def test_parse_judge_response_with_no_json_object_raises() -> None:
    with pytest.raises(ValueError, match="valid JSON"):
        parse_judge_response("No JSON here at all.", _item().answer_points)  # type: ignore[attr-defined]


def test_judge_item_credits_points_the_scripted_judge_marks_true() -> None:
    judge = scripted_judge({"duty": True, "covers-unit": False})
    result = judge_item(
        _item(),
        answer_text="The landlord must keep the unit in repair.",
        judge_client=judge,
    )
    verdicts = {v.point_id: v.credited for v in result.point_verdicts}
    assert verdicts == {"duty": True, "covers-unit": False}


def test_judge_item_point_score_is_the_fraction_of_points_credited() -> None:
    judge = scripted_judge({"duty": True, "covers-unit": False})
    result = judge_item(_item(), answer_text="…", judge_client=judge)
    assert result.point_score == 0.5  # 1 of 2 credited


def test_empty_scripted_judge_violates_the_one_verdict_per_point_contract() -> None:
    # Documents why --no-judge cannot use scripted_judge({}): the empty map emits
    # NO verdicts, and judge_item requires one per rubric point, so it raises.
    with pytest.raises(ValueError, match="omitted a verdict"):
        judge_item(_item(), answer_text="…", judge_client=scripted_judge({}))


def test_no_op_judge_credits_nothing_but_satisfies_the_per_point_contract() -> None:
    # The --no-judge fallback: a verdict for EVERY point (so judge_item does not
    # raise) but crediting nothing, leaving the point-score column at 0.0.
    result = judge_item(_item(), answer_text="anything", judge_client=no_op_judge())
    assert result.point_score == 0.0
    assert len(result.point_verdicts) == 2
    assert all(not v.credited for v in result.point_verdicts)
    assert not result.all_points_credited


def test_judge_item_all_points_credited_is_a_perfect_point_score() -> None:
    judge = scripted_judge({"duty": True, "covers-unit": True})
    result = judge_item(_item(), answer_text="…", judge_client=judge)
    assert result.point_score == 1.0
    assert result.all_points_credited is True


def test_judge_item_no_points_credited_scores_zero() -> None:
    judge = scripted_judge({"duty": False, "covers-unit": False})
    result = judge_item(_item(), answer_text="…", judge_client=judge)
    assert result.point_score == 0.0
    assert result.all_points_credited is False


def test_judge_item_raises_if_the_judge_omits_a_point() -> None:
    # A judge that returns a verdict for only one of two points is a contract
    # violation — every rubric point must get a binary verdict.
    incomplete = scripted_judge({"duty": True})
    try:
        judge_item(_item(), answer_text="…", judge_client=incomplete)
    except ValueError as error:
        assert "covers-unit" in str(error)
    else:  # pragma: no cover - the test fails if no error is raised
        raise AssertionError("expected a ValueError for the missing point verdict")


def test_judge_point_verdict_carries_a_rationale() -> None:
    judge = scripted_judge({"duty": True, "covers-unit": True}, rationale="grounded in the answer")
    result = judge_item(_item(), answer_text="…", judge_client=judge)
    assert all(isinstance(v, JudgePointVerdict) for v in result.point_verdicts)
    assert all(v.rationale for v in result.point_verdicts)
