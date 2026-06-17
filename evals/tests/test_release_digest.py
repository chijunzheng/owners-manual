"""Release-digest generation tests (issue #21 AC4).

The committed failure digest is generated FROM Langfuse data only (CONTEXT.md,
"Disposition": "derived from Langfuse, never the primary record"). This pins the
orchestration: it reads the dispositioned failures through an INJECTED reader
(the live, mocked Langfuse seam), clusters them, and renders the derived artifact
— so the generation path is exercised offline with no live server.
"""

from __future__ import annotations

from owners_manual_evals.disposition import FailureStage
from owners_manual_evals.failure_digest import DispositionedFailure
from owners_manual_evals.release_digest import generate_release_digest


def _failure(item_id: str, *, stage: FailureStage, corpus: str = "tenancy") -> DispositionedFailure:
    return DispositionedFailure(
        item_id=item_id,
        trace_id=item_id + "-trace",
        behavior_class="answer",
        corpus=corpus,
        stage=stage,
        disposition="bug",
    )


def test_generates_the_digest_from_the_injected_langfuse_reader() -> None:
    failures = (
        _failure("f1", stage=FailureStage.RETRIEVAL),
        _failure("f2", stage=FailureStage.SYNTHESIS),
    )
    calls: list[bool] = []

    def read_failures() -> tuple[DispositionedFailure, ...]:
        calls.append(True)
        return failures

    text = generate_release_digest(read_dispositioned_failures=read_failures, run_name="release-v0")

    # The digest was derived from the reader's data (the reader was consulted).
    assert calls == [True]
    assert "derived" in text.lower()
    assert "f1" in text
    assert "f2" in text


def test_a_clean_release_renders_an_empty_digest() -> None:
    text = generate_release_digest(read_dispositioned_failures=lambda: (), run_name="release-v0")
    assert "clean release" in text.lower()
