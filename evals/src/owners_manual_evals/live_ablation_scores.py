"""Live Langfuse reader for the two-ladder ablation tables (issue #23 AC3).

The README ablation tables are DERIVED from Langfuse (CONTEXT.md, "Disposition").
This module is the live binding behind the table generator's injected reader: it
reads each rung's strict-pass scores back from Langfuse — aggregated by the
``{run_name}:{rung_id}`` run name the runner tagged them with — and the per-stage
rescue counts, then assembles them into the ``buildup`` / ``knockout`` /
``mechanism`` rows :func:`ablation_tables.generate_ablation_tables` consumes.

Following :mod:`live_runner`/:mod:`live_annotation_queue`, the PURE assembly
(:func:`assemble_ladder_rows`) is unit-tested offline; the actual Langfuse fetch
(:func:`build_ladder_score_reader` and its helpers) is the ``pragma: no cover``
live seam, reached lazily so importing this module needs no SDK.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from .ablation_ladders import ladder_run_plan
from .ablation_tables import (
    LadderRowFromLangfuse,
    MechanismRowFromLangfuse,
)


def assemble_ladder_rows(
    *,
    strict_pass_by_rung: Mapping[str, float],
    rescue_by_stage: Mapping[str, tuple[int, int]],
) -> dict[str, list[object]]:
    """Assemble the table generator's reader dict from per-rung aggregates.

    ``strict_pass_by_rung`` maps each rung id (from :func:`ladder_run_plan`) to the
    strict-pass rate read off Langfuse; ``rescue_by_stage`` maps a retrieval stage
    to its ``(reached, rescued_only)`` counts. The rows come out in the canonical
    dependency order the README tables expect. Raises ``ValueError`` if a rung in
    the plan has NO score — a derived table must not silently show 0.00% for a rung
    that was never run.
    """
    plan = ladder_run_plan()
    buildup: list[object] = []
    knockout: list[object] = []
    for step in plan:
        if step.rung_id not in strict_pass_by_rung:
            raise ValueError(
                f"no Langfuse strict-pass score for rung {step.rung_id!r}; the ladder "
                "run is incomplete (a derived table must not invent a 0.00% rung)"
            )
        row = LadderRowFromLangfuse(
            ladder=step.ladder,
            component_key=step.component_key,
            strict_pass_rate=strict_pass_by_rung[step.rung_id],
        )
        (buildup if step.ladder == "build-up" else knockout).append(row)

    mechanism: list[object] = [
        MechanismRowFromLangfuse(stage=stage, reached=reached, rescued_only=rescued_only)
        for stage, (reached, rescued_only) in rescue_by_stage.items()
    ]
    return {"buildup": buildup, "knockout": knockout, "mechanism": mechanism}


# --- live Langfuse binding -------------------------------------------------

#: The strict-pass score name the runner writes per item (matches the score sink
#: in :mod:`run_naive_rag` / :mod:`live_runner`).
_STRICT_PASS_SCORE = "strict_pass"


def _mean(values: list[float]) -> float:  # pragma: no cover - live wiring
    return sum(values) / len(values) if values else 0.0


def _strict_pass_for_run_name(langfuse: Any, *, run_name: str) -> float:  # pragma: no cover
    """Mean strict-pass over every trace tagged with ``run_name`` in Langfuse.

    Reads the harness traces by their ``runName`` metadata (the runner tags each
    rung ``{run_name}:{rung_id}``) and averages their ``strict_pass`` scores —
    the rung's strict-pass rate, derived purely from Langfuse."""
    values: list[float] = []
    page = 1
    while True:
        response = langfuse.api.trace.list(tags=None, page=page)
        data = getattr(response, "data", None) or []
        for trace in data:
            metadata = getattr(trace, "metadata", None) or {}
            if isinstance(metadata, dict) and metadata.get("runName") == run_name:
                for score in getattr(trace, "scores", None) or []:
                    if getattr(score, "name", None) == _STRICT_PASS_SCORE:
                        value = getattr(score, "value", None)
                        if isinstance(value, (int, float)):
                            values.append(float(value))
        meta = getattr(response, "meta", None)
        total_pages = getattr(meta, "total_pages", page) if meta is not None else page
        if page >= total_pages:
            break
        page += 1
    return _mean(values)


def build_ladder_score_reader(  # pragma: no cover - live wiring
    langfuse: Any,
    *,
    run_name: str,
) -> Callable[[], Mapping[str, list[object]]]:
    """A reader that fetches every rung's strict-pass from Langfuse and assembles
    the table rows. The mechanism (per-stage rescue) counts are read from the
    release-time rescue export when present; absent that, the mechanism table is
    empty rather than fabricated."""

    def read() -> Mapping[str, list[object]]:
        plan = ladder_run_plan()
        strict_pass_by_rung = {
            step.rung_id: _strict_pass_for_run_name(langfuse, run_name=f"{run_name}:{step.rung_id}")
            for step in plan
        }
        return assemble_ladder_rows(strict_pass_by_rung=strict_pass_by_rung, rescue_by_stage={})

    return read


__all__ = ["assemble_ladder_rows", "build_ladder_score_reader"]
