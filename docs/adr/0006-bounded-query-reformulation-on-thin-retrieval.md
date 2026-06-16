# Bounded query reformulation on a thin first retrieval

Extends the bounded agent graph ([ADR 0005](./0005-provider-split-vertex-gemini-runtime-claude-offline-batch.md) for the model binding; the Guard→Critic topology and the "all iteration is explicit bounded edges" contract in CONTEXT.md, "Planner"). Closes the honest gap left by #16 (PR #52, Codex P2): the `reformulate` edge existed but only incremented a counter, so re-entering the planner re-planned the *same* question and the second retrieval pass was identical to the first — a no-op for a deterministic planner.

This ADR pins how reformulation actually rewrites the query.

## Decision

When the `queryReformulation` flag is on **and** the first retrieval pass comes back thin (empty candidate set), the agent rewrites the query once and retrieves again on the rewrite.

- **Signal — a thin first pass.** Reformulation is a *rescue*, not an always-on rewrite. The router (`routeAfterRetrieve`) already keyed the `reformulate` edge on an empty candidate set; that same signal drives the rewrite. A first pass that returned anything proceeds straight to rerank, so a healthy query is never perturbed and pays no extra model call.
- **Rewrite — an injected model seam.** A `reformulate(question, candidates) -> rewrittenQuestion` method joins guard/plan/synthesize/critique on the `AgentModel` seam. Like the others it is injected: the orchestrator never calls a provider directly, so the node is unit-tested offline against a deterministic fake (no network). The live binding wires the same product model as every other seam — Gemini on Vertex (ADR 0005) — so the rewrite is held at the same model as the rest of the arm and arm gaps still measure architecture, not model choice.
- **Direction — broaden recall.** The prompt asks for a broadened, jargon-rich rephrasing (synonyms, the governing Act/term, e.g. "Residential Tenancies Act"/"RTA") that keeps the same information need and the Ontario condo-ownership scope. An empty result usually means the query missed the corpus's vocabulary, so broadening is the rescue that fits the signal; narrowing would make a thin set thinner.
- **State — rewrite stored, original preserved.** The rewrite lands on `AgentState.reformulatedQuestion`; the original `question` is never overwritten. A single `effectiveQuestion(state)` helper (`reformulatedQuestion ?? question`) is the one point where the rewrite takes effect: the planner re-plans over it and the retrieve node falls back to it for an empty-query hop, so the second pass searches the rewrite while the original survives for provenance/trace. The rewrite is always derived from the *original* question (not a prior rewrite), keeping provenance stable.

## Bounding

The reformulation budget is `AGENT_LOOP_CAPS.maxReformulations = 1`, enforced by the router, not by the node — exactly as #16 left it. The edge is explicit (`retrieve → reformulate → planner`), never an open-ended ReAct loop, so the trajectory stays comparable across eval runs (CONTEXT.md, "Planner"). At the cap the router routes to rerank regardless of how thin the set is, so the graph always terminates; the graph's `recursionLimit` remains a belt-and-braces backstop that a well-formed run never reaches. The independent Critic re-retrieval loop (`maxCriticReretrievals = 1`) is unchanged and separately capped.

## Off-state (the ablation contract)

With `queryReformulation` off — and under `AGENT_QUERY_FLAGS_OFF`, the #15 baseline #23's ablation measures lift against — the router never returns `reformulate`, so the node, the injected seam, and any rewrite are never reached. `reformulatedQuestion` stays undefined, `effectiveQuestion` collapses to exactly `state.question`, and the run is byte-identical to today's: one retrieve pass, no extra model call, same trajectory. This is pinned by explicit off-state tests at both the node and graph level (the seam is asserted never-called).

## Considered alternatives

- **Always rewrite the query (every run).** Rejected: spends a model call on every query, perturbs healthy retrievals that needed no help, and muddies the ablation — the lift would no longer isolate the rescue behaviour. Gating on a thin pass keeps reformulation a measurable, targeted component.
- **Deterministic broadening (provider-free rewrite — stemming, stop-word stripping, synonym tables).** Tempting because it needs no model call and is trivially deterministic, but a hand-rolled synonym/stemming layer is brittle across four legal corpora and would itself need an ablation. Keeping the rewrite behind the same injected seam as the other LLM-shaped decisions matches the established pattern, keeps the strategy swappable, and stays offline-testable via the deterministic fake — we get determinism in tests without hard-coding a broadening heuristic in product.
- **HyDE / generate-a-hypothetical-document then embed that.** A heavier retrieval-time technique; more moving parts and another thing to ablate. Out of scope for closing the #16 no-op — a single query rewrite is the minimal change that makes the second pass differ, and HyDE can be revisited as its own flagged component later.
- **Let the Critic re-retrieval own this.** Rejected: the Critic loop fires *after* synthesis on an *ungrounded* answer; it is a different signal (grounding failure, not retrieval miss) and re-plans the original question by design. Reformulation belongs at retrieve, before synthesis, on the thin-result signal — the two bounded loops stay distinct.

## Consequences

- `AgentModel` gains a fifth method; the live `createVertexAgentModel` binding and the scripted fake both implement it. The fake's default rewrite is a recognizable pure transform of the question so a test can assert the second retrieve saw the rewrite.
- The live reformulator returns bare query text (not JSON) — the rewrite is a string the second retrieve embeds — and falls back to the original question if the model returns nothing, so a degenerate reply never blanks out the second retrieval.
- `reformulatedQuestion` is a new last-write-wins state channel; the original question remains the provenance anchor in the trace.
- This component is now a real knock-out for #23's two-ladder ablation (build-up: what the rewrite rescued; leave-one-out: what breaks without it), measured via the per-stage rescue stats rather than assumed.
