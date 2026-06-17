"""Selecting the single smoke comment to update on a PR (issue #11; PR #57 Codex P1).

The smoke workflow keeps ONE score comment per PR and updates it on each push,
finding it by the hidden marker the body carries. The original implementation did
this in YAML with ``gh api --paginate --slurp --jq '.[] | select(.body|...)'`` —
but ``--slurp`` folds each PAGE (itself an array for the issue-comments endpoint)
into the outer array, so ``.[]`` yielded page-arrays and ``.body`` indexed an
array → ``Cannot index array with string "body"``, even with zero comments. Under
``continue-on-error`` that silently skipped posting, breaking AC1 (every PR gets a
comment). The fix moves selection into this pure, unit-tested helper, fed by the
FLAT array ``gh api --paginate`` already merges (no ``--slurp``).
"""

from __future__ import annotations

import io
import json

from owners_manual_evals.smoke_comment import SMOKE_COMMENT_MARKER
from owners_manual_evals.smoke_pr_comment import main, select_comment_id_to_update


def _comment(comment_id: int, body: str) -> dict:
    return {"id": comment_id, "body": body}


def _marked() -> str:
    return f"{SMOKE_COMMENT_MARKER}\n### Smoke eval — `smoke-v1`"


def test_selects_the_id_of_the_comment_whose_body_starts_with_the_marker() -> None:
    comments = [
        _comment(1, "a human comment"),
        _comment(2, _marked()),
        _comment(3, "another comment"),
    ]
    assert select_comment_id_to_update(comments, SMOKE_COMMENT_MARKER) == 2


def test_returns_none_when_no_comment_carries_the_marker() -> None:
    comments = [_comment(1, "just discussion"), _comment(2, "no marker here")]
    assert select_comment_id_to_update(comments, SMOKE_COMMENT_MARKER) is None


def test_returns_none_for_an_empty_comment_list() -> None:
    # The zero-comment case the --slurp bug crashed on must yield a clean "post new".
    assert select_comment_id_to_update([], SMOKE_COMMENT_MARKER) is None


def test_selects_the_earliest_matching_comment_when_several_match() -> None:
    comments = [_comment(7, _marked()), _comment(9, _marked())]
    assert select_comment_id_to_update(comments, SMOKE_COMMENT_MARKER) == 7


def test_skips_malformed_entries_without_a_string_body() -> None:
    # Defensive: a non-dict (e.g. if --slurp were ever reintroduced, a page is a
    # list) or a body-less dict must be skipped, never raise.
    comments = [["not", "a", "comment"], {"id": 5}, _comment(8, _marked())]
    assert select_comment_id_to_update(comments, SMOKE_COMMENT_MARKER) == 8


def test_main_prints_the_matching_id_from_stdin_json(monkeypatch, capsys) -> None:
    payload = json.dumps([{"id": 1, "body": "hi"}, {"id": 2, "body": _marked()}])
    monkeypatch.setattr("sys.stdin", io.StringIO(payload))
    assert main() == 0
    assert capsys.readouterr().out.strip() == "2"


def test_main_prints_nothing_when_no_comment_matches(monkeypatch, capsys) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO('[{"id": 1, "body": "hi"}]'))
    assert main() == 0
    assert capsys.readouterr().out.strip() == ""


def test_main_treats_empty_stdin_as_no_comments(monkeypatch, capsys) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    assert main() == 0
    assert capsys.readouterr().out.strip() == ""
