"""Find the one smoke comment to update on a PR (issue #11).

The smoke workflow keeps a SINGLE score comment per PR, updating it on each push
rather than stacking a new one. It identifies that comment by the hidden marker
:data:`~owners_manual_evals.smoke_comment.SMOKE_COMMENT_MARKER` the body carries.

This is a pure selection over the comment list ``gh api --paginate`` returns — a
single FLAT array, because pagination already merges the per-page arrays. It lives
here, unit-tested, because the same logic embedded as a ``gh api --slurp --jq``
one-liner in the workflow YAML was both untestable and wrong: ``--slurp`` folds
each PAGE (itself an array for this endpoint) into the outer array, so the filter
read ``.body`` off a page-array and errored even with zero comments (PR #57, Codex
P1). The workflow now pipes the flat ``--paginate`` array to :func:`main`.
"""

from __future__ import annotations

import json
import sys
from collections.abc import Sequence

from .smoke_comment import SMOKE_COMMENT_MARKER


def select_comment_id_to_update(comments: Sequence[object], marker: str) -> int | None:
    """Return the id of the first comment whose body starts with ``marker``.

    ``comments`` is the flat list ``gh api --paginate`` returns for the PR's
    issue-comments endpoint. Returns ``None`` when none match (the caller then
    posts a fresh comment). Malformed entries — non-dicts, or dicts lacking a
    string ``body`` / integer ``id`` — are skipped rather than raising, so one odd
    entry can never swallow the whole step (it runs under ``continue-on-error``).
    """
    for comment in comments:
        if not isinstance(comment, dict):
            continue
        body = comment.get("body")
        comment_id = comment.get("id")
        if isinstance(body, str) and body.startswith(marker) and isinstance(comment_id, int):
            return comment_id
    return None


def main() -> int:
    """CLI: read the ``gh api --paginate`` comments JSON on stdin, print the id of
    the comment to update (or nothing, signalling "post a new comment"). Always
    exits 0; empty stdin is treated as "no comments"."""
    raw = sys.stdin.read()
    comments = json.loads(raw) if raw.strip() else []
    comment_id = select_comment_id_to_update(comments, SMOKE_COMMENT_MARKER)
    if comment_id is not None:
        print(comment_id)
    return 0


__all__ = ["main", "select_comment_id_to_update"]


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
