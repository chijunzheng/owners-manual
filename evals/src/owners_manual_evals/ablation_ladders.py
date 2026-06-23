"""The two-ladder ablation runner: component attribution over eight components.

CONTEXT.md ("Ablation ladder"): "The two-ladder decomposition of the naive-rag→
agent gap over eight components in dependency order: cumulative build-up (what
each component added on arrival) plus leave-one-out (what breaks if removed from
the final system). A component big on build-up but small on knock-out was absorbed
by later additions — a redundancy finding. Every off-state has a defined fallback;
runs at milestones."

README ("Component attribution") pins the eight components and three off-state
fallbacks: "the naive-rag → agent gap bundles eight components (hierarchy chunks,
contextual enrichment, hybrid BM25, metadata filters, graph expansion, authority
rerank, planner, critic) ... Every off-state has a defined fallback (planner-off =
single hop across all corpora; critic-off = unverified synthesis; rerank-off = raw
similarity order); build-up attributions are order-dependent and the README says
so rather than hiding it."

This module owns the component model and the rung → flag-configuration mapping —
the AC2 surface ("off-states documented and enforced for all eight components").
The ladder runner (AC1), the Langfuse-derived README tables (AC3), and the
redundancy findings (AC4) build on top of it in the same file's later sections.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

from .bootstrap import ConfidenceInterval, bootstrap_paired_gap_ci, strict_pass_rate
from .metrics import ItemScore


@dataclass(frozen=True, slots=True)
class AblationComponent:
    """One ablatable pipeline component: its stable key, label, and OFF-state.

    ``off_state`` is the DEFINED fallback when this component is ablated — the
    behaviour the pipeline degrades to, documented here so a knock-out is never a
    crash or an undefined path (CONTEXT.md: "Every off-state has a defined
    fallback"). ``index_time`` marks the components whose off-state needs a
    different corpus build (chunking/enrichment/index shape) rather than a free
    query-time flag flip (CONTEXT.md: index-time vs query-time experiments).
    """

    key: str
    label: str
    off_state: str
    index_time: bool


#: The eight components, in DEPENDENCY ORDER (README, "Component attribution").
#: The build-up ladder adds them left-to-right; the knock-out ladder removes one
#: at a time from the full system. Each off-state is the defined fallback the
#: pipeline degrades to when the component is ablated.
EIGHT_COMPONENTS: tuple[AblationComponent, ...] = (
    AblationComponent(
        key="hierarchy-chunks",
        label="Hierarchy-aware chunks",
        off_state="fixed-size chunks on citable-unit-blind boundaries (the naive-rag chunker)",
        index_time=True,
    ),
    AblationComponent(
        key="contextual-enrichment",
        label="Contextual chunk enrichment",
        off_state="no situating context prepended before embedding; the chunk text is embedded raw",
        index_time=True,
    ),
    AblationComponent(
        key="hybrid-bm25",
        label="Hybrid BM25 + vector",
        off_state="vector-only top-k retrieval; the BM25 leg is dropped (the naive-rag retriever)",
        index_time=False,
    ),
    AblationComponent(
        key="metadata-filters",
        label="Metadata pre-filters",
        off_state="no metadata pre-filter; retrieval ranges over every chunk in the build",
        index_time=False,
    ),
    AblationComponent(
        key="graph-expansion",
        label="Cross-reference graph expansion",
        off_state="no graph expansion; the candidate set is exactly hybrid retrieval's output",
        index_time=False,
    ),
    AblationComponent(
        key="authority-rerank",
        label="Authority-weighted rerank",
        off_state="raw similarity order (the fused-score order); no authority weighting is applied",
        index_time=False,
    ),
    AblationComponent(
        key="planner",
        label="Retrieval planner",
        off_state="single hop across all corpora; no corpus routing or multi-hop fan-out",
        index_time=False,
    ),
    AblationComponent(
        key="critic",
        label="Critic gate",
        off_state="unverified synthesis; no claim-to-chunk check and no Critic re-retrieval",
        index_time=False,
    ),
)

#: The component keys in dependency order — the build-up ladder's add sequence.
COMPONENT_KEYS: tuple[str, ...] = tuple(c.key for c in EIGHT_COMPONENTS)

_COMPONENT_BY_KEY = {c.key: c for c in EIGHT_COMPONENTS}


@dataclass(frozen=True, slots=True)
class LadderFlags:
    """The component on/off configuration at one ladder rung.

    A value, not a mutable bag (matches the TS ``AgentQueryFlags`` /
    ``ConsumerFlags`` seams): ``enabled`` is the frozenset of component keys that
    are ON, and every component NOT in it is ablated to its documented off-state.
    The split between query-time and index-time components is derived from
    :data:`EIGHT_COMPONENTS` so a rung knows which arms need a rebuilt corpus
    build and which are free flag flips.
    """

    enabled: frozenset[str]

    @property
    def enabled_components(self) -> tuple[str, ...]:
        """The enabled component keys, in canonical dependency order."""
        return tuple(key for key in COMPONENT_KEYS if key in self.enabled)

    @property
    def disabled_components(self) -> tuple[str, ...]:
        """The ablated component keys (each degraded to its off-state), in order."""
        return tuple(key for key in COMPONENT_KEYS if key not in self.enabled)

    def is_on(self, key: str) -> bool:
        """True when ``key`` is enabled at this rung. Raises on an unknown key so a
        typo cannot read as a silent off."""
        if key not in _COMPONENT_BY_KEY:
            raise ValueError(_unknown_component_message(key))
        return key in self.enabled


def naive_rag_flags() -> LadderFlags:
    """The naive-rag floor: every component OFF (the tutorial pipeline).

    CONTEXT.md ("Naive-RAG baseline"): "Fixed-size chunks, vector-only top-k, no
    reranking, no agent graph." This is build-up rung 0 and the gap's lower anchor.
    """
    return LadderFlags(enabled=frozenset())


def full_system_flags() -> LadderFlags:
    """The full agent system: every component ON. The build-up ladder's top rung
    and the base every knock-out removes exactly one component from."""
    return LadderFlags(enabled=frozenset(COMPONENT_KEYS))


def _unknown_component_message(key: str) -> str:
    return f"unknown component {key!r}; expected one of {list(COMPONENT_KEYS)}"


def require_component(key: str) -> AblationComponent:
    """The component for ``key`` or a ``ValueError`` naming the closed set — so a
    typo fails loudly at the boundary rather than silently ablating nothing."""
    component = _COMPONENT_BY_KEY.get(key)
    if component is None:
        raise ValueError(_unknown_component_message(key))
    return component


def flags_for_buildup_rung(rung: int) -> LadderFlags:
    """The build-up ladder's flags at ``rung``: the first ``rung`` components ON.

    Rung 0 is the naive-rag floor (nothing on); rung ``len(EIGHT_COMPONENTS)`` is
    the full system. Cumulative by construction — each rung adds the next component
    in dependency order on top of all earlier ones (CONTEXT.md: "what each
    component added on arrival"). Raises ``ValueError`` for an out-of-range rung so
    a miscount cannot silently clamp to a partial ladder.
    """
    if not 0 <= rung <= len(EIGHT_COMPONENTS):
        raise ValueError(f"build-up rung must be in [0, {len(EIGHT_COMPONENTS)}]; got {rung}")
    return LadderFlags(enabled=frozenset(COMPONENT_KEYS[:rung]))


def flags_for_knockout_rung(component_key: str) -> LadderFlags:
    """The leave-one-out flags for ``component_key``: the full system minus that one.

    The knock-out measures "what breaks if removed from the final system"
    (CONTEXT.md), so every OTHER component stays on and only this one degrades to
    its off-state. Raises ``ValueError`` for an unknown key (the closed set is the
    eight components).
    """
    require_component(component_key)
    return LadderFlags(enabled=frozenset(COMPONENT_KEYS) - {component_key})


# --- corpus-build selection (the PINNED build set) -------------------------

#: The full corpus build: every index-time component in its ON shape (hierarchy
#: chunks + contextual enrichment). Every query-time-only rung reuses it.
BUILD_FULL = "build-full"
#: The build whose chunks are hierarchy-aware but carry NO situating context —
#: contextual-enrichment ablated, hierarchy-chunks kept.
BUILD_NO_ENRICHMENT = "build-no-enrichment"
#: The naive-rag build: fixed-size chunks AND no enrichment (both index-time
#: components off). Enrichment situates the chunker's output, so an enrichment-on
#: shape over fixed-size chunks is incoherent and never occurs — three builds
#: cover every index-time shape both ladders reach.
BUILD_NAIVE_CHUNKS = "build-naive-chunks"

#: The pinned build set the ladders run against, in a stable order. "~16 golden-
#: set runs over 3 corpus builds" (README) — these are the three.
DEFAULT_PINNED_BUILDS: tuple[str, ...] = (BUILD_FULL, BUILD_NO_ENRICHMENT, BUILD_NAIVE_CHUNKS)


def build_for_rung(flags: LadderFlags, *, pinned_builds: Sequence[str]) -> str:
    """The corpus build one rung's flags require, drawn from the pinned set.

    The build is a function of the INDEX-TIME components only (CONTEXT.md: query-
    time flags flip free on the same build; index-time shapes are distinct builds):

    * hierarchy-chunks off                       → :data:`BUILD_NAIVE_CHUNKS`
      (fixed-size chunks; enrichment is meaningless without the hierarchy chunker
      it situates, so this build carries no enrichment either);
    * hierarchy-chunks on, enrichment off        → :data:`BUILD_NO_ENRICHMENT`;
    * both index-time components on               → :data:`BUILD_FULL`.

    Raises ``ValueError`` if the required build is not in ``pinned_builds`` — the
    ladder numbers are comparable only against known, pinned builds.
    """
    if not flags.is_on("hierarchy-chunks"):
        build = BUILD_NAIVE_CHUNKS
    elif not flags.is_on("contextual-enrichment"):
        build = BUILD_NO_ENRICHMENT
    else:
        build = BUILD_FULL
    if build not in pinned_builds:
        raise ValueError(
            f"rung requires corpus build {build!r}, absent from the pinned build set "
            f"{list(pinned_builds)} — ladder arms must run against pinned builds "
            "(CONTEXT.md, Corpus build)"
        )
    return build


# --- the two-ladder runner (AC1) -------------------------------------------

#: A per-rung runner: take the rung's flag configuration and its corpus build,
#: return that arm's deterministic per-item scores. Injected so the whole ladder
#: loop is unit-tested offline against a fake; the live binding drives the four
#: arms against the deployed service with the rung's flags resolved into the env.
RunRung = Callable[[LadderFlags, str], tuple[ItemScore, ...]]


@dataclass(frozen=True, slots=True)
class LadderRung:
    """One rung of a ladder: its flags, the build it ran on, and the gap delta.

    ``component_key`` is the component this rung attributes its delta to — the one
    ADDED on a build-up rung, the one REMOVED on a knock-out rung — or ``None`` for
    the build-up ladder's naive-rag floor (rung 0, which adds nothing). ``delta`` is
    the paired-by-item strict-pass gap with a seeded bootstrap CI: rung-minus-prev
    on build-up (value on arrival), knock-out-minus-full on knock-out (value in
    place, so a removal that hurts is a negative delta).
    """

    ladder: str
    component_key: str | None
    flags: LadderFlags
    build: str
    strict_pass_rate: float
    delta: ConfidenceInterval


@dataclass(frozen=True, slots=True)
class LadderRunResult:
    """Both ladders' rungs from one run, plus the run name for rendering."""

    run_name: str
    buildup: tuple[LadderRung, ...]
    knockout: tuple[LadderRung, ...]


def _zero_delta(*, confidence: float, iterations: int) -> ConfidenceInterval:
    """A degenerate CI for the floor rung, which has no predecessor to diff against
    — a flat zero interval so the floor still carries a uniform delta shape."""
    return ConfidenceInterval(
        point_estimate=0.0,
        low=0.0,
        high=0.0,
        confidence=confidence,
        iterations=iterations,
    )


def run_ablation_ladders(
    *,
    run_rung: RunRung,
    pinned_builds: Sequence[str] = DEFAULT_PINNED_BUILDS,
    seed: int,
    iterations: int = 2000,
    confidence: float = 0.95,
    run_name: str = "ablation-ladders",
) -> LadderRunResult:
    """Run BOTH ladders from one call against the pinned build set (AC1).

    The cumulative build-up ladder runs rungs 0..8 (naive-rag floor, then each
    component added in dependency order); its per-rung delta is rung-minus-previous
    (value on arrival). The leave-one-out knock-out ladder runs the full system
    minus each component once; its delta is knock-out-minus-full (value in place).
    Each rung's corpus build is resolved from ``pinned_builds`` via
    :func:`build_for_rung`, so an unpinned build is a hard error. Every delta is a
    paired-by-item bootstrap CI seeded from ``seed`` (distinct stream per rung), so
    the whole run is reproducible. Raises ``ValueError`` (via the bootstrap) if two
    compared rungs do not cover the same item ids — deltas are paired by item.
    """
    # Build-up ladder: rung 0 = naive floor, rung k adds the k-th component.
    buildup_scores: list[tuple[LadderFlags, str, tuple[ItemScore, ...]]] = []
    for rung in range(len(EIGHT_COMPONENTS) + 1):
        flags = flags_for_buildup_rung(rung)
        build = build_for_rung(flags, pinned_builds=pinned_builds)
        buildup_scores.append((flags, build, tuple(run_rung(flags, build))))

    buildup: list[LadderRung] = []
    for index, (flags, build, scores) in enumerate(buildup_scores):
        if index == 0:
            delta = _zero_delta(confidence=confidence, iterations=iterations)
            component_key: str | None = None
        else:
            prev_scores = buildup_scores[index - 1][2]
            delta = bootstrap_paired_gap_ci(
                baseline=prev_scores,
                treatment=scores,
                statistic=strict_pass_rate,
                iterations=iterations,
                seed=seed + index,
                confidence=confidence,
            )
            component_key = COMPONENT_KEYS[index - 1]
        buildup.append(
            LadderRung(
                ladder="build-up",
                component_key=component_key,
                flags=flags,
                build=build,
                strict_pass_rate=strict_pass_rate(scores),
                delta=delta,
            )
        )

    # Knock-out ladder: the full system, then minus each component once.
    full_flags = full_system_flags()
    full_build = build_for_rung(full_flags, pinned_builds=pinned_builds)
    full_scores = tuple(run_rung(full_flags, full_build))

    knockout: list[LadderRung] = []
    for offset, key in enumerate(COMPONENT_KEYS):
        flags = flags_for_knockout_rung(key)
        build = build_for_rung(flags, pinned_builds=pinned_builds)
        scores = tuple(run_rung(flags, build))
        delta = bootstrap_paired_gap_ci(
            baseline=full_scores,
            treatment=scores,
            statistic=strict_pass_rate,
            iterations=iterations,
            # Seed past the build-up rungs so no two rungs share a resample stream.
            seed=seed + len(EIGHT_COMPONENTS) + 1 + offset,
            confidence=confidence,
        )
        knockout.append(
            LadderRung(
                ladder="knock-out",
                component_key=key,
                flags=flags,
                build=build,
                strict_pass_rate=strict_pass_rate(scores),
                delta=delta,
            )
        )

    return LadderRunResult(run_name=run_name, buildup=tuple(buildup), knockout=tuple(knockout))


# --- run plan: rung → env → build (AC1/AC2, live wiring) -------------------


#: The agent's query-time env flags (`agent-query-flags.ts`,
#: ``resolveAgentQueryFlags``) and which component each is gated on. The service
#: resolves these from the environment, so a rung's off-states reach the live
#: service as env: a component OFF turns its env flag(s) OFF. The four flags are
#: covered by the eight components as follows:
#:   * ``OWNERS_MANUAL_XREF_EXPANSION``        ← graph-expansion
#:   * ``OWNERS_MANUAL_RERANK``                ← authority-rerank
#:   * ``OWNERS_MANUAL_DEFINITIONS_IN_PROMPT`` ← graph-expansion AND planner (the
#:     definitions-index ride-along is meaningful only once the agent graph plans
#:     and the cross-reference sidecar is in play)
#:   * ``OWNERS_MANUAL_QUERY_REFORMULATION``   ← planner (the bounded reformulate
#:     edge is a planner-gated hop; ADR 0006)
#: so the full system turns all four ON and the naive floor turns all four OFF.
def _env_truthy(on: bool) -> str:
    return "1" if on else "0"


def rung_env(flags: LadderFlags) -> dict[str, str]:
    """The ``OWNERS_MANUAL_*`` env a rung's flag configuration resolves to.

    The bridge from a :class:`LadderFlags` rung to the env the live service reads
    (`agent-query-flags.ts`): each query-time component's off-state turns its env
    flag OFF, so standing the service up with this env enforces the rung's
    ablation. The non-env components (chunks, enrichment, hybrid, metadata, planner
    routing, critic) are realised by the rung's corpus build and the service build
    the operator deploys — see :func:`ladder_run_plan`, which pairs this env with
    :func:`build_for_rung`.
    """
    xref = flags.is_on("graph-expansion")
    rerank = flags.is_on("authority-rerank")
    planner = flags.is_on("planner")
    return {
        "OWNERS_MANUAL_XREF_EXPANSION": _env_truthy(xref),
        "OWNERS_MANUAL_RERANK": _env_truthy(rerank),
        "OWNERS_MANUAL_DEFINITIONS_IN_PROMPT": _env_truthy(xref and planner),
        "OWNERS_MANUAL_QUERY_REFORMULATION": _env_truthy(planner),
    }


@dataclass(frozen=True, slots=True)
class RunPlanStep:
    """One step of the live ladder plan: which arm to stand the service up as.

    ``rung_id`` is the stable Langfuse run-name suffix for the rung (so the
    Langfuse-derived tables can read each rung's scores back by name); ``env`` is
    the ``OWNERS_MANUAL_*`` env the service is deployed with; ``build`` is the
    pinned corpus build it serves. A milestone operator walks the plan, standing
    the service up per step (CONTEXT.md: ~16 runs over 3 builds, at milestones).
    """

    ladder: str
    rung_id: str
    component_key: str | None
    flags: LadderFlags
    build: str
    env: dict[str, str]


def ladder_run_plan(
    *, pinned_builds: Sequence[str] = DEFAULT_PINNED_BUILDS
) -> tuple[RunPlanStep, ...]:
    """The full per-rung run plan for both ladders (the live milestone runbook).

    Build-up: the naive-rag floor then each component added in dependency order
    (9 steps). Knock-out: the full system minus each component (8 steps). Each step
    pairs the rung's :func:`rung_env` with its :func:`build_for_rung`, so an
    unpinned build raises here too. The plan is the documented, enforced form of
    the off-states (AC2) and the runbook the one-command live runner walks (AC1).
    """
    steps: list[RunPlanStep] = []
    for rung in range(len(EIGHT_COMPONENTS) + 1):
        flags = flags_for_buildup_rung(rung)
        component_key = None if rung == 0 else COMPONENT_KEYS[rung - 1]
        rung_id = "buildup-00-floor" if rung == 0 else f"buildup-{rung:02d}-{component_key}"
        steps.append(
            RunPlanStep(
                ladder="build-up",
                rung_id=rung_id,
                component_key=component_key,
                flags=flags,
                build=build_for_rung(flags, pinned_builds=pinned_builds),
                env=rung_env(flags),
            )
        )
    for offset, key in enumerate(COMPONENT_KEYS):
        flags = flags_for_knockout_rung(key)
        steps.append(
            RunPlanStep(
                ladder="knock-out",
                rung_id=f"knockout-{offset:02d}-{key}",
                component_key=key,
                flags=flags,
                build=build_for_rung(flags, pinned_builds=pinned_builds),
                env=rung_env(flags),
            )
        )
    return tuple(steps)


# --- redundancy findings (AC4) ---------------------------------------------

#: The smallest build-up arrival delta a component must show to be a redundancy
#: CANDIDATE — "big on build-up". Below this the component never added much, so a
#: small knock-out is just a consistently minor component, not absorption.
REDUNDANCY_BUILDUP_THRESHOLD = 0.10
#: The largest knock-out removal magnitude that still counts as "small on knock-
#: out". At or below this, removing the component barely dents the final system.
REDUNDANCY_KNOCKOUT_THRESHOLD = 0.05


@dataclass(frozen=True, slots=True)
class RedundancyFinding:
    """One component's redundancy verdict, with the two deltas it was judged from.

    A component is REDUNDANT when it was big on build-up (arrival delta ≥
    :data:`REDUNDANCY_BUILDUP_THRESHOLD`) yet small on knock-out (removal magnitude
    ≤ :data:`REDUNDANCY_KNOCKOUT_THRESHOLD`): it added value on arrival that LATER
    components then absorbed, so removing it from the finished system costs little
    (CONTEXT.md, "Ablation ladder"). Both deltas are carried so the verdict is
    auditable, never a bare boolean.
    """

    component_key: str
    #: The build-up arrival delta (rung-minus-previous strict pass) — value on arrival.
    buildup_delta: float
    #: The knock-out removal MAGNITUDE (|knock-out minus full|) — value in place.
    knockout_magnitude: float
    is_redundant: bool


def redundancy_findings(result: LadderRunResult) -> tuple[RedundancyFinding, ...]:
    """Per-component redundancy findings from a ladder run (AC4).

    For each component, pair its build-up arrival delta (the rung that added it)
    with its knock-out removal magnitude (the rung that removed it) and flag it
    redundant when it was big on build-up but small on knock-out. Findings are
    returned in dependency order. A component missing from either ladder is skipped
    (a partial run cannot be judged for absorption).
    """
    buildup_delta_by_key = {
        rung.component_key: rung.delta.point_estimate
        for rung in result.buildup
        if rung.component_key is not None
    }
    knockout_magnitude_by_key = {
        rung.component_key: abs(rung.delta.point_estimate) for rung in result.knockout
    }

    findings: list[RedundancyFinding] = []
    for key in COMPONENT_KEYS:
        if key not in buildup_delta_by_key or key not in knockout_magnitude_by_key:
            continue
        buildup_delta = buildup_delta_by_key[key]
        knockout_magnitude = knockout_magnitude_by_key[key]
        is_redundant = (
            buildup_delta >= REDUNDANCY_BUILDUP_THRESHOLD
            and knockout_magnitude <= REDUNDANCY_KNOCKOUT_THRESHOLD
        )
        findings.append(
            RedundancyFinding(
                component_key=key,
                buildup_delta=buildup_delta,
                knockout_magnitude=knockout_magnitude,
                is_redundant=is_redundant,
            )
        )
    return tuple(findings)


# --- console rendering ------------------------------------------------------

#: The order-dependence caveat printed BESIDE the build-up ladder (README:
#: "build-up attributions are order-dependent and the README says so rather than
#: hiding it"). Each arrival delta is conditional on the components already added.
ORDER_DEPENDENCE_CAVEAT = (
    "CAVEAT: build-up arrival deltas are ORDER-DEPENDENT — each is conditional on "
    "the components already added in dependency order. A different add order would "
    "redistribute the same total gap differently. The leave-one-out (knock-out) "
    "ladder is order-free: it measures value in place. Read the two ladders "
    "together — a component big on build-up but small on knock-out was absorbed by "
    "later additions (a redundancy finding), not unimportant."
)


def _fmt_signed_pct(value: float) -> str:
    sign = "+" if value >= 0 else "-"
    return f"{sign}{abs(value):.2%}"


def _label_for(component_key: str | None) -> str:
    if component_key is None:
        return "(naive-rag floor)"
    return require_component(component_key).label


def render_ladders(result: LadderRunResult) -> str:
    """Render both ladders, the redundancy findings, and the order-dependence
    caveat as aligned console text (the human-facing report; the README tables are
    the Langfuse-derived markdown built in :mod:`ablation_tables`).

    Honest by construction: the build-up ladder carries its order-dependence caveat
    inline, the knock-out ladder is labeled order-free, and redundancy findings are
    surfaced by name with both deltas shown."""
    findings = redundancy_findings(result)
    redundant = {f.component_key for f in findings if f.is_redundant}

    lines = [
        f"=== {result.run_name} — two-ladder ablation over {len(EIGHT_COMPONENTS)} components ===",
        "",
        ORDER_DEPENDENCE_CAVEAT,
        "",
        "BUILD-UP ladder (value on arrival — each component added in dependency order):",
    ]
    header = f"{'rung':<5}{'component':<30}{'build':<22}{'strict':>8}  {'Δ on arrival':>13}"
    lines.append(header)
    lines.append("-" * len(header))
    for index, rung in enumerate(result.buildup):
        delta = (
            "         —"
            if rung.component_key is None
            else _fmt_signed_pct(rung.delta.point_estimate)
        )
        lines.append(
            f"{index:<5}{_label_for(rung.component_key):<30}{rung.build:<22}"
            f"{rung.strict_pass_rate:>8.2%}  {delta:>13}"
        )

    lines.append("")
    lines.append("KNOCK-OUT ladder (value in place — full system minus one component; order-free):")
    lines.append(header)
    lines.append("-" * len(header))
    for rung in result.knockout:
        flag = "  ← redundant" if rung.component_key in redundant else ""
        lines.append(
            f"{'—':<5}{_label_for(rung.component_key):<30}{rung.build:<22}"
            f"{rung.strict_pass_rate:>8.2%}  {_fmt_signed_pct(rung.delta.point_estimate):>13}{flag}"
        )

    lines.append("")
    lines.append("REDUNDANCY findings (big on build-up, small on knock-out → absorbed later):")
    find_header = f"{'component':<40}{'Δ arrival':>11}  {'|Δ removal|':>12}  verdict"
    lines.append(find_header)
    lines.append("-" * len(find_header))
    any_redundant = False
    for finding in findings:
        verdict = "REDUNDANT" if finding.is_redundant else "load-bearing"
        any_redundant = any_redundant or finding.is_redundant
        # Name by stable key plus label so the verdict is both human-readable and
        # grep-able by the component key the issue and CONTEXT.md use.
        name = f"{_label_for(finding.component_key)} [{finding.component_key}]"
        lines.append(
            f"{name:<40}{_fmt_signed_pct(finding.buildup_delta):>11}  "
            f"{finding.knockout_magnitude:>11.2%}  {verdict}"
        )
    if not any_redundant:
        lines.append("(no component met the redundancy bar — every one is load-bearing in place.)")
    return "\n".join(lines)


def render_run_plan(plan: Sequence[RunPlanStep], *, run_name: str) -> str:
    """Render the live milestone runbook: per rung, the corpus build and the env
    exports to stand the service up with, then the one-command invocation.

    This is a MILESTONE activity, not a per-merge CI job (CONTEXT.md: ~16 runs over
    3 builds, at milestones). An operator walks each step, deploys the service with
    the shown build + env, and runs that rung; the Langfuse-derived README tables
    (`generate-ablation-readme`) then read every rung back by ``run_name``."""
    lines = [
        f"=== {run_name} — two-ladder ablation run plan (MILESTONE runbook) ===",
        "",
        "This is a milestone activity, not a per-merge CI job: ~16 golden-set runs "
        "over 3 corpus builds, the service stood up per arm. For each rung below, "
        "deploy the service with the shown corpus build + env, then run that rung:",
        "",
        f"    uv run ablation-ladders --rung <rung_id> --service-url <url> --run-name {run_name}",
        "",
    ]
    for step in plan:
        exports = " ".join(f"{name}={value}" for name, value in sorted(step.env.items()))
        lines.append(f"[{step.rung_id}]  ladder={step.ladder}  build={step.build}")
        lines.append(f"    env: {exports}")
    lines.append("")
    lines.append(
        "After all rungs are run and Langfuse holds their scores, regenerate the "
        "README tables (derived, never hand-typed):"
    )
    lines.append(f"    uv run generate-ablation-readme --run-name {run_name} --write")
    return "\n".join(lines)


# --- live CLI wiring -------------------------------------------------------


def _rung_step_by_id(plan: Sequence[RunPlanStep], rung_id: str) -> RunPlanStep:  # pragma: no cover
    for step in plan:
        if step.rung_id == rung_id:
            return step
    valid = ", ".join(step.rung_id for step in plan)
    raise ValueError(f"unknown rung id {rung_id!r}; valid rung ids: {valid}")


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no cover - live wiring
    """Live entry point for the two-ladder ablation runner (AC1, one command).

    ``--print-plan`` emits the milestone runbook (every rung's build + env) and
    exits — the safe default, since the live runs are a milestone activity, not a
    CI job. With ``--rung <id>`` it runs that single rung's items against a service
    the operator has ALREADY stood up with the rung's build + env (the agent's
    query-time flags resolve service-side from ``OWNERS_MANUAL_*``), tagging the
    Langfuse scores with the rung's run name so the README generator can read them
    back. It never restarts the service itself and never executes the full ~16-run
    matrix in one process — that is the operator walking the printed plan.
    """
    import argparse  # noqa: PLC0415
    import sys  # noqa: PLC0415

    parser = argparse.ArgumentParser(
        prog="ablation-ladders",
        description="Two-ladder ablation runner (build-up + leave-one-out) over the eight "
        "components. A MILESTONE activity: print the run plan, or run one rung against a "
        "service stood up with that rung's build + env.",
    )
    parser.add_argument("--service-url", default="http://127.0.0.1:8787")
    parser.add_argument("--run-name", default="ablation-ladders-v0")
    parser.add_argument(
        "--print-plan",
        action="store_true",
        help="Print the milestone runbook (per-rung build + env) and exit. Default action.",
    )
    parser.add_argument(
        "--rung",
        default=None,
        help="Run this single rung id against a service already configured for it "
        "(see --print-plan for the valid rung ids and their env).",
    )
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    plan = ladder_run_plan()
    if args.rung is None or args.print_plan:
        print(render_run_plan(plan, run_name=args.run_name))
        return 0

    # Single-rung live run: the service must already serve the rung's build with
    # the rung's env. We score the agent arm for this rung and write strict-pass to
    # Langfuse tagged by the rung's run name, so the tables read it back by name.
    step = _rung_step_by_id(plan, args.rung)
    print(
        f"Running rung [{step.rung_id}] against {args.service_url}\n"
        f"  EXPECTED service build: {step.build}\n"
        f"  EXPECTED service env:   " + " ".join(f"{k}={v}" for k, v in sorted(step.env.items())),
        file=sys.stderr,
    )

    from .agent_live_runner import build_agent_answer  # noqa: PLC0415
    from .env_file import load_root_env  # noqa: PLC0415
    from .golden_v0 import load_golden_v0_documents, load_golden_v0_set  # noqa: PLC0415

    load_root_env()
    from .live_runner import build_score_sink, finalize_langfuse  # noqa: PLC0415
    from .run_naive_rag import run_items, select_run_items  # noqa: PLC0415

    documents = load_golden_v0_documents()
    items = select_run_items(load_golden_v0_set(), include_holdout=False)

    rung_run_name = f"{args.run_name}:{step.rung_id}"
    try:
        from .live_runner import _build_langfuse  # noqa: PLC0415

        langfuse = _build_langfuse()
    except RuntimeError as error:
        print(f"Langfuse not configured: {error}", file=sys.stderr)
        return 2

    answer = build_agent_answer(
        service_url=args.service_url, run_name=rung_run_name, langfuse=langfuse
    )
    try:
        result = run_items(
            items=items,
            documents=documents,
            answer=answer,
            score_sink=build_score_sink(langfuse),
        )
    finally:
        finalize_langfuse(langfuse)

    from .dashboard import render_dashboard  # noqa: PLC0415

    print(render_dashboard(result.dashboard, run_name=rung_run_name))
    return 0


__all__ = [
    "AblationComponent",
    "EIGHT_COMPONENTS",
    "COMPONENT_KEYS",
    "LadderFlags",
    "naive_rag_flags",
    "full_system_flags",
    "require_component",
    "flags_for_buildup_rung",
    "flags_for_knockout_rung",
    "BUILD_FULL",
    "BUILD_NO_ENRICHMENT",
    "BUILD_NAIVE_CHUNKS",
    "DEFAULT_PINNED_BUILDS",
    "build_for_rung",
    "rung_env",
    "RunPlanStep",
    "ladder_run_plan",
    "RunRung",
    "LadderRung",
    "LadderRunResult",
    "run_ablation_ladders",
    "REDUNDANCY_BUILDUP_THRESHOLD",
    "REDUNDANCY_KNOCKOUT_THRESHOLD",
    "RedundancyFinding",
    "redundancy_findings",
    "ORDER_DEPENDENCE_CAVEAT",
    "render_ladders",
    "render_run_plan",
    "main",
]


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
