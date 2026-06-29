"""Judge-judge κ + the README calibration table (issue #19, ADR 0010 Decisions 3 & 6).

ADR 0010 Decision 6: Gemini runs over the same answers as a same-family DIAGNOSTIC,
never averaged into the headline. Three κ are published — κ(Claude↔human) (the
primary trust label), κ(Gemini↔human), κ(Claude↔Gemini): high judge-judge κ with low
agreement-to-human flags the shared same-family bias ADR 0005's cross-family split
exists to catch. Decision 3 fixes the Landis–Koch trust bands.

This module is pure:

* :func:`judge_judge_kappas` — the three κ from three aligned per-point verdict
  streams (human, Claude, Gemini), reusing :func:`calibration.cohen_kappa`;
* :func:`trust_band` — the Landis–Koch label for a κ (κ≥0.61 trusted; 0.41–0.60
  published with disagreement analysis; <0.41 not trusted);
* :func:`render_calibration_table` — the README table (three κ + the primary CI +
  observed agreement + prevalence + the per-behavior-class headline).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal

from .calibration import CalibrationResult, Pair, cohen_kappa

#: The Landis–Koch trust label a published κ carries (ADR 0010 Decision 3).
TrustBand = Literal["trusted", "published-with-analysis", "not-trusted"]


@dataclass(frozen=True, slots=True)
class PointDecision:
    """One rater's binary credit for one answer point (the ``*_point:<id>`` score).
    Three aligned streams — human, Claude, Gemini — feed the judge-judge κ."""

    item_id: str
    point_id: str
    behavior_class: str
    credited: bool


@dataclass(frozen=True, slots=True)
class JudgeJudgeKappa:
    """The three published κ (ADR 0010 Decision 6). ``claude_vs_human`` is the
    primary trust label; the other two are Gemini diagnostics, never headline."""

    claude_vs_human: float
    gemini_vs_human: float
    claude_vs_gemini: float


def _keyed(stream: Sequence[PointDecision]) -> dict[tuple[str, str], bool]:
    return {(d.item_id, d.point_id): d.credited for d in stream}


def _paired(a: Mapping[tuple[str, str], bool], b: Mapping[tuple[str, str], bool]) -> list[Pair]:
    """Pair two keyed streams over their shared, identical key set (sorted for
    determinism). Raises if the streams do not cover exactly the same points — a κ
    over a mismatched set is meaningless (the paired-bootstrap discipline)."""
    if a.keys() != b.keys():
        raise ValueError(
            "judge-judge streams must cover the same (item, point) keys to align "
            "(a κ over a mismatched set is meaningless)"
        )
    return [(a[key], b[key]) for key in sorted(a)]


def judge_judge_kappas(
    *,
    human: Sequence[PointDecision],
    claude: Sequence[PointDecision],
    gemini: Sequence[PointDecision],
) -> JudgeJudgeKappa:
    """Compute κ(Claude↔human), κ(Gemini↔human), κ(Claude↔Gemini) from three aligned
    per-point verdict streams. All three streams must cover the same points."""
    human_keyed = _keyed(human)
    claude_keyed = _keyed(claude)
    gemini_keyed = _keyed(gemini)
    return JudgeJudgeKappa(
        claude_vs_human=cohen_kappa(_paired(claude_keyed, human_keyed)),
        gemini_vs_human=cohen_kappa(_paired(gemini_keyed, human_keyed)),
        claude_vs_gemini=cohen_kappa(_paired(claude_keyed, gemini_keyed)),
    )


def trust_band(kappa: float) -> TrustBand:
    """The Landis–Koch trust label for ``kappa`` (ADR 0010 Decision 3).

    κ≥0.61 → ``"trusted"`` (judge carries the headline); 0.41–0.60 →
    ``"published-with-analysis"`` (published with the κ + disagreement analysis);
    <0.41 → ``"not-trusted"`` (revise the rubric / judge prompt before publishing).
    Always a label, never a pass/fail gate."""
    if kappa >= 0.61:
        return "trusted"
    if kappa >= 0.41:
        return "published-with-analysis"
    return "not-trusted"


def _fmt(value: float) -> str:
    return f"{value:.2f}"


def render_calibration_table(
    *,
    primary: CalibrationResult,
    judge_judge: JudgeJudgeKappa,
) -> str:
    """Render the README calibration table (ADR 0010 Decisions 3 & 6).

    The primary row (Claude↔human) carries the seeded-bootstrap CI, the trust band,
    observed agreement, and prevalence; the two Gemini rows are diagnostic only and
    carry no CI (never averaged into the headline). The per-behavior-class κ — the
    Decision 1 headline — follows as its own small table.
    """
    ci = primary.kappa_ci
    band = trust_band(primary.kappa)

    lines = [
        "## Judge calibration (issue #19, ADR 0010)",
        "",
        "| Pairing | Cohen's κ | 95% CI | Trust |",
        "| --- | --- | --- | --- |",
        f"| Claude ↔ human (primary) | {_fmt(primary.kappa)} "
        f"| [{_fmt(ci.low)}, {_fmt(ci.high)}] | {band} |",
        f"| Gemini ↔ human (diagnostic) | {_fmt(judge_judge.gemini_vs_human)} | — | — |",
        f"| Claude ↔ Gemini (diagnostic) | {_fmt(judge_judge.claude_vs_gemini)} | — | — |",
        "",
        (
            f"Observed agreement {_fmt(primary.observed_agreement)} · "
            f"positive prevalence {_fmt(primary.positive_prevalence)} · "
            f"negative prevalence {_fmt(primary.negative_prevalence)} · "
            f"n={primary.n_decisions} point-decisions."
        ),
        "",
        "Gemini is the same-family secondary judge — diagnostic only, never averaged "
        "into the headline (ADR 0005 cross-family split).",
        "",
        "Per-behavior-class κ (Claude ↔ human):",
        "",
        "| Behavior class | Cohen's κ |",
        "| --- | --- |",
    ]
    for behavior_class in sorted(primary.per_class_kappa):
        lines.append(f"| {behavior_class} | {_fmt(primary.per_class_kappa[behavior_class])} |")

    return "\n".join(lines) + "\n"


__all__ = [
    "TrustBand",
    "PointDecision",
    "JudgeJudgeKappa",
    "judge_judge_kappas",
    "trust_band",
    "render_calibration_table",
]
