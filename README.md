# owners-manual

**The missing owner's manual for owning a condo.** Ask it the questions condo ownership actually generates — *"Can I raise my tenant's rent 10%?"*, *"My tenant's dishwasher flooded the unit below — who pays, and can I evict?"*, *"Does my policy or the corporation's master policy cover this?"* — and get answers grounded in the Ontario statutes, tribunal guidelines, and policy wordings that govern them, with section-level citations on every claim and an explicit refusal to guess.

> **Status:** design complete; build in progress (Phase 0). This README describes the target system; sections will flip from spec to results as phases land.

## Why this exists

I own a condo in Ontario. The documents that govern it — the Residential Tenancies Act, LTB interpretation guidelines, two insurance policies with a precedence relationship, a declaration, bylaws, rules — total thousands of pages, and the answer to any real question usually spans several of them. Generic chatbots hallucinate section numbers. This is the tool I wanted: an agent that reads the fine print and shows its work.

## Architecture

```
                       ┌─────────────────────────────────────────────┐
 user ── SSE chat ──▶  │  LangGraph.js agent (TypeScript)            │
                       │                                             │
                       │  Guard ─▶ Planner ─▶ Hybrid retrieve ─▶     │
                       │  Rerank ─▶ Synthesize ─▶ Critic gate        │
                       │     │            │                          │
                       └─────┼────────────┼──────────────────────────┘
                             │            │
              MongoDB Atlas ─┴────────────┴─ swappable ChatModel layer
              (collections + vector       (runtime: ChatVertexAI/Gemini │
               search + BM25, one DB)      offline: Claude — enrich+judge)
                             ▲
        Python eval harness ─┘  RAGAS + custom metrics ▶ Langfuse
        (black-box over HTTP)   Datasets/Experiments ▶ CI eval gate
```

- **Guard** — Ontario-only jurisdiction boundary, prompt-injection screening of retrieved content, information-not-advice boundary with escalation (LTB / lawyer / broker)
- **Planner** — structured-output retrieval plan: which corpora, single- vs multi-hop
- **Hybrid retrieve** — per-corpus Atlas vector + BM25 with authority-level metadata filters
- **Rerank** — Cohere Rerank vs LLM-rerank (A/B'd in evals), weighted by the legal **authority hierarchy**: Act > Regulation > LTB Guideline > policy wording > lease clause
- **Synthesize** — streamed answer; every legal claim carries a **pin-cite**; conflict rules applied (a lease clause that contradicts the RTA is void — say so, cite both)
- **Critic gate** — claims must map to retrieved chunks; one re-retrieval on failure, then honest degradation
- **Memory** — session summary + cross-session **owner profile** (your unit, your policies) in MongoDB

See [CONTEXT.md](./CONTEXT.md) for the domain language and [docs/adr/](./docs/adr/) for the decisions worth recording (provider split by workload shape, Atlas Vector Search over a dedicated vector DB, TS-product/Python-evals split, two-track ingestion).

## What makes the RAG non-trivial

Legal corpora break naive chunking. The pipeline owns:

1. **Hierarchy-aware chunking** — chunks carry their position in the document tree (Act → Part → Section → Subsection), so a retrieved subsection knows its parents and citations resolve precisely
2. **Authority-weighted reranking** — when sources conflict, precedence is a ranking feature, not an afterthought
3. **Amendment/conflict resolution** — void-clause detection: contract text that loses to statute is flagged, not parroted
4. **Embedding selection as measurement** — `voyage-law-2` (legal-tuned) vs `gemini-embedding-001` (general-purpose, rides the GCP credit), compared on the golden set, not chosen by vibes
5. **Contextual enrichment as a measured ablation** — LLM-written situating context per chunk (contextual retrieval), shipped behind a flag so the lift is proven on *this* corpus, not assumed from a blog post

## Ingestion pipeline

**Deterministic skeleton, LLM flesh** ([ADR 0004](./docs/adr/0004-two-track-ingestion-with-split-llm-enrichment.md)): structure comes from the document wherever the document provides it; LLMs recover structure where it's missing and enrich everywhere — and never re-author source text.

```
statutes (e-laws HTML)         policies / declarations / BYOD (PDF)
        │                                   │
 deterministic parse               Claude PDF read + structure
 (citable-unit tree)               recovery (same adapter)
        │                          + pdftotext coverage check
        └─────────────┬─────────────────────┘
                      ▼
        document tree (JSON, zod-validated)
                      ▼
        deterministic clean (whitespace, amendment notes)
                      ▼
        tree-level enrich (LLM): xref graph,      keyed to tree hash —
        definitions index                          survives chunker changes
                      ▼
        chunk = deterministic traversal            granularity policy
        at citable units                           is itself an A/B
                      ▼
        chunk-level enrich (LLM): situating        keyed to chunk hash +
        context, term links                        prompt version
                      ▼
        embed (context + chunk) → Atlas indexes

        build = hash(source manifest + pipeline config)
```

- **Content-addressed builds** — every eval number pins to an exact build, so "did chunker v3 help?" is an experiment, not an opinion
- **Ablation flags live at the consumer** — `chunk_context` (index-time: rebuild per arm), `xref_expansion` / `definitions_in_prompt` / `query_reformulation` (query-time: free flag flips on the same index). Amendment-note flagging ("not yet in force") is a correctness invariant: eval-tested, never ablated
- **Intrinsic evals in CI** — every source section lands in the tree exactly once; cite round-trips (chunk → path → lookup → identical text); text-fidelity diff vs source; table cell checks on designed fixtures; a **golden extraction set** of hand-verified hard sections (definitions, embedded tables, repealed text)
- **Per-stage caches** — chunker iteration re-enriches only changed chunks; experiments stay cheap

## Retrieval mechanism

Index time amortizes intelligence into the index (pipeline above); query time *consumes* it through deterministic lookups — **find → follow → filter → verify**. No enrichment LLM runs per query:

```
 "My lease says no pets — can my landlord evict me over a cat?"
        │
        ▼
 ① Planner → plan: corpora = [tenancy, governing-docs], hops
        │
        ▼
 ② HYBRID SEARCH  (vector + BM25, RRF-fused, corpus/authority filters)
        │   the bare clause "(1) A provision…void" is findable ONLY
        │   because its situating context is in the vector        ◄── chunk-level
        ▼                                                             enrichment
    hits: RTA s.14 (no-pet clause void) · declaration ¶4 (pets)
        │
        ▼
 ③ GRAPH EXPANSION  (deterministic lookups, 1 hop)
        │   follow xref edges:   s.14 ──► s.76 (condo pet pathway)  ◄── tree-level
        │   attach definitions:  "tenant" ► s.2 text                    enrichment
        │   check flags:         mark not-in-force candidates
        ▼
    expanded candidate pool (recall ↑)
        │
        ▼
 ④ RERANK  (authority-weighted: Act > Reg > Guideline > contract)
        │   expansion grew the pool; rerank restores precision
        ▼
 ⑤ SYNTHESIZE  from packet: chunks + contexts + definitions
        │   + authority labels  →  streamed answer, pin-cite per claim
        ▼
 ⑥ CRITIC  claim ↦ chunk check; a cited-but-unretrieved section is
            fetched by tree path directly — the tree enables lookup,
            not just search
    (section numbers illustrative; every cite verified at golden-set time)
```

Two clarifications that matter:

**The xref graph is a document graph, not an entity knowledge graph.** Statutes are drafter-formalized — defined terms and cross-references are written into the text — so ingestion *recovers* a graph the author encoded rather than *inferring* entities from prose. No entity-resolution problem (node identity = citable path), no community summaries (the planner's corpus fan-out and the authority hierarchy already organize the corpus), and edges have ground truth, which is why edge precision/recall is a testable intrinsic metric. It's GraphRAG's local-search expansion applied to a graph that can actually be audited.

**Agentic ≠ open-ended ReAct.** The model reasons at explicit nodes; every loop is a bounded graph edge — so Guard and Critic are guaranteed to run, trajectories stay comparable across eval runs, and cost/latency have ceilings:

```
Guard ─► Planner ─► [ hop: retrieve ─► rerank ] × N   (N capped by plan)
                         │        ▲
                         └─ reformulate ≤1 on low-confidence results
                                          │
                    Synthesize ◄──────────┘
                         │
                       Critic ─► answer
                         ▲  │
                         └──┘ ≤1 re-retrieval; second failure → honest degradation
```

Query-time behaviors (`xref_expansion`, `definitions_in_prompt`, `query_reformulation`) are ablation flags — see Evaluation.

## Why not just paste the Act into Claude?

Honest answer: for one person with one question and the right document in hand, that works — and the corpus is small enough (~2–3 MB of text) that "no retrieval, whole corpus in a 1M-token context window" is a runnable configuration, not a strawman. So the eval harness runs it as one. Every golden-set question goes through four arms — all running the **same product model**, so arm gaps measure architecture, never model choice:

| Pipeline | Who selects what the model sees? | What it is |
|---|---|---|
| `stuff` | nobody | No retrieval — all four corpora in one ~600–900K-token context, fixed canonical order, cached prefix. The honest "paste everything into a chatbot" (no upload caps, full attention budget) |
| `stuff-oracle` | an oracle | Only the human-routed relevant corpus in context — isolates cross-corpus routing from within-corpus retrieval |
| `naive-rag` | top-k similarity | Fixed-size chunks, vector-only, no reranking, no agent. The tutorial baseline |
| `agent` | the agent | The full graph: hierarchy-aware chunks, hybrid retrieval, graph expansion, authority-weighted rerank, critic gate |

The results table reports citation accuracy, answer correctness, refusal correctness, **cost per question, and latency** for all arms. Where `stuff` wins a metric, the table says so. The paired stuffing arms decompose any lift: `stuff ≈ stuff-oracle` means routing is easy in-context and the agent must justify itself on retrieval and discipline; `stuff-oracle ≫ stuff` means cross-corpus interference is real and the Planner specifically earns its place. All arms run under the same output contract (pin-cites required, information-not-advice, jurisdiction rules) — which makes `stuff` double as a probe of whether prompt-only guardrails hold without the structural Guard.

What the agent buys beyond that table:

1. **Pin-cite fidelity is enforced, not hoped.** Long-context answers still misattribute section numbers under cross-document load — Canadian courts have already sanctioned lawyers for AI-hallucinated citations. The critic gate rejects any claim that doesn't map to a retrieved chunk, and citation accuracy is a CI-gated metric.
2. **Precedence is a rule, not a vibe.** "Your lease says X, but the RTA voids that clause" requires authority ordering applied deterministically, with adversarial tests proving it holds.
3. **Currency.** The corpus pipeline re-ingests amendments and the annual rent-increase guideline; a chatbot silently blends your upload with stale training-data memory and won't tell you which one answered.
4. **Cost and latency are the product at scale.** A stuffed query costs dollars and tens of seconds of prefill; a retrieval query costs cents and runs in seconds. Noise for one user — the entire bill for anything multi-user.
5. **Tested guardrails.** Jurisdiction refusal, the information-not-advice boundary, and injection screening are eval-gated behaviors, not system-prompt wishes.

## Evaluation

Per-corpus **golden sets** plus an **adversarial set**: jurisdiction traps (BC questions), off-topic questions, hallucination bait ("what does s. 999 say?"), injection attempts, void-clause conflicts, advice-seeking phrasings. Items are rubric-structured, hand-verified, and provenance-mandatory — ~75 items v1 (tenancy ~40, insurance ~25, plus ~10 **cross-corpus** tenancy×insurance items so the Planner's fan-out is measured from day one), ~45 v2 (governing ~20, selling ~15, plus ~10 scripted **multi-turn dialogues** exercising session memory and the owner profile), ~30 adversarial. Each golden item also gets 2–3 paraphrase variants, scored against the same rubric and reported as a separate **robustness delta**, never mixed into the headline number:

```yaml
id: TEN-014
corpus: [tenancy]
persona: tenant
question: "My landlord says I have to move out because the buyer wants
           to live here. Can they do that?"
expected:
  behavior: answer            # or refuse-jurisdiction | refuse-out-of-scope |
                              #    refuse-advice-escalate | flag-void-clause
  answer_points:              # claim-level rubric, judged per point
    - "purchaser's-own-use eviction pathway exists"
    - "notice period + compensation-or-alternative-unit requirement"
  required_cites: ["RTA s. 49"]
difficulty: multi-hop
source: "LTB Guideline 12, worked example 3"
```

Cite grading is **hierarchical via citable paths** — an answer citing s. 49(1)(a) satisfies a required s. 49 (descendant covers ancestor); citing bare s. 49 against a required subsection scores partial. The same document tree that powers retrieval powers the metric, deterministically. Refusals are first-class: an adversarial item's golden answer is a behavior class, not reference text.

**Scoring is a dashboard, never a blend.** Per arm × slice, the published table reports: **strict pass rate** (item passes iff behavior class matches, every answer point credited, every required cite satisfied — the headline), **point score** (mean fraction of answer points credited — the diagnostic gradient), **citation precision/recall** (deterministic via citable paths), and **cost/latency** (tokens, $, p50/p95). Gate thresholds attach per metric; a blended composite would hide which dimension regressed behind indefensible weights. Slices (per-corpus, cross-corpus, adversarial, paraphrase-robustness) are reported separately and never averaged together — a composition change would masquerade as a quality change.

**Variance is measured, not suppressed.** Current Claude models expose no temperature control, so determinism isn't on the menu. Runs are n=1 per item; arms are compared **paired-by-item** on the same corpus build, with a bootstrap CI over items attached to every published gap. A ~15-item **variance audit** slice runs ×5 per release and publishes the per-arm run-to-run noise floor — highest for the agent arm, where planner nondeterminism compounds through routing. Any gap or "regression" inside the noise floor is labeled *within noise*; gate thresholds are calibrated from jitter observed during the report-only phase.

**The benchmark has a holdout.** Golden items split ~70/30 dev/holdout, stratified by corpus × behavior class at authoring time; paraphrase variants inherit their parent's side. Prompt and pipeline iteration — and failure-trace reading — touch dev items only; the holdout runs only in the release-tier full suite. The dashboard publishes dev and holdout columns side by side: persistent divergence is the overfit detector. Its job is detection, not precision — a wide CI on 30 items still catches a systematic dev-only gain.

- RAGAS: faithfulness, answer relevancy, context precision/recall
- Custom: citation accuracy (exact section match), refusal correctness, authority-ordering correctness — plus **required-cite hit rate**, measured *before synthesis*: did the right citable paths reach the candidate set at all? Splits every failure into retrieval's fault vs synthesis's fault. Each candidate carries **stage-provenance** tags (vector rank, BM25 rank, graph-expansion edge, rerank survivor), so ladder outcomes come with mechanism stats — "graph expansion rescued N% of required cites that similarity missed" — all deterministic set-comparisons, no LLM judge needed
- Runner: pytest; rubric judges are hand-rolled prompts logged as Langfuse Scores (DeepEval considered, rejected — one judge stack, one system of record)
- **Judge validation**: Claude judges all arms — **cross-family by default**, since the product model is Gemini, so self-preference bias has no purchase on the headline numbers (rubric-anchored binary per-point scoring resists style bias); a ~20-item human-labeled **calibration slice** publishes judge–human agreement (Cohen's kappa), with Gemini as the *same-family* secondary judge on the slice (judge–judge agreement reported). Judge calls are offline batch — they ride the Agent SDK credit (verify at build: credit usable headlessly in CI via `claude setup-token`, else Anthropic API key)
- **Tiered**: smoke on every merge — intrinsic ingestion asserts plus a fixed 12-item agent slice (`smoke-v1`: all five behavior classes, every corpus, ≥1 cross-corpus item, drawn from stable-at-baseline items so a failure is signal, not flake), scored with deterministic metrics only (~$1/merge, billed to Vertex via a CI service account against the GCP credit); full LLM-judge suite nightly/per-release; baseline matrix + A/B arms per release. Smoke composition is versioned (`smoke-v1`, `smoke-v2`) and changes only at milestones — trend lines must compare like with like
- Tracked as Langfuse Datasets/Experiments; embedding, reranker, and ingestion A/Bs are first-class experiments; the Python harness propagates trace-ids so every score joins the exact TS-service spans it measured
- **Error analysis is a gate, not a habit**: every full-tier run pushes its failures into a Langfuse annotation queue; each failure gets a categorical **disposition** score (`bug` / `rubric-wrong` / `known-limitation` / `noise`) before the harness will launch the next experiment — the pre-flight check refuses while the queue is non-empty. A release-time export commits the clustered failure digest to the repo as a derived artifact; `rubric-wrong` dispositions are the golden set's own bug tracker
- Every question runs through all four arms (`stuff` / `stuff-oracle` / `naive-rag` / `agent`), all on the same product model (Gemini on Vertex) — arm gaps measure architecture, never model choice; stuffed runs ride Vertex context caching on fixed corpus prefixes and execute per-release, not per-merge (verify at build: current Gemini context window covers the ~900K `stuff` arm; Vertex long-context and context-caching pricing; heavy matrix/ladder runs scheduled inside the 90-day GCP credit window)
- Cross-arm comparison uses only arm-agnostic, golden-set-anchored metrics (citation accuracy, answer correctness, refusal correctness); retrieval-internal metrics (context precision/recall, precision@k) exist only for the RAG arms and the table shows that honestly
- Stuffing sensitivity probe: a ~10-question slice re-runs with permuted document order (uncached) to check the baseline isn't an artifact of prefix ordering
- **Component attribution**: the `naive-rag` → `agent` gap bundles eight components (hierarchy chunks, contextual enrichment, hybrid BM25, metadata filters, graph expansion, authority rerank, planner, critic), so a **two-ladder ablation** decomposes it — a cumulative build-up ladder (value on arrival) plus leave-one-out knock-outs (value in place), ~16 golden-set runs over 3 corpus builds, run at milestones rather than per release. Every off-state has a defined fallback (planner-off = single hop across all corpora; critic-off = unverified synthesis; rerank-off = raw similarity order); build-up attributions are order-dependent and the README says so rather than hiding it. The ladder runner and its off-state contract live in `evals/src/owners_manual_evals/ablation_ladders.py`; `uv run ablation-ladders --print-plan` emits the per-rung build + env runbook, and the results tables below are regenerated from Langfuse by `uv run generate-ablation-readme --write` — derived, never hand-typed

<!-- owners-manual-ablation-ladders -->

_The two-ladder ablation results table is generated from Langfuse at milestones (`uv run generate-ablation-readme --write`), once the live runs over the three pinned corpus builds have populated each rung's scores. No numbers are hand-typed here — this block is a derived view, regenerated from the system of record._

<!-- owners-manual-ablation-ladders -->

- Non-goal, documented: public benchmarks (LegalBench, generic RAG suites) — they measure the base model on someone else's distribution, with no pin-cite contract or authority hierarchy; a number without evidence about *this* system
- **CI eval gate, staged**: report-only through Phases 1–2 (every PR gets a smoke-tier score-table comment — deterministic metrics, LLM-judge-free, ~$1/merge), flipped to blocking in Phase 3/4 once baselines stabilize; gates the `agent` pipeline only. Gates earn the right to block by first proving they don't cry wolf

## Stack

| Concern | Choice |
|---|---|
| Agent orchestration | LangGraph.js (TypeScript) |
| Ingestion | Two-track: deterministic e-laws parser + Claude PDF reading; tree-/chunk-level LLM enrichment; content-addressed builds |
| LLM | Split by workload shape — runtime: Gemini on Vertex AI via `ChatVertexAI` (agent + all four arms, GCP credit); offline batch: Claude via Agent SDK / `claude -p` (ingestion enrichment + primary judge, subscription credit); Agent SDK adapter for the product path = post-credit fallback |
| Data + vectors | MongoDB Atlas (collections + Vector Search + BM25, one database) |
| Embeddings | voyage-law-2 vs gemini-embedding-001 (eval-selected) |
| Reranking | Cohere Rerank 3.5 vs LLM-rerank (eval-selected) |
| Evals | Python: RAGAS + custom metrics, Langfuse Datasets/Experiments |
| Observability | Langfuse, self-hosted via Docker Compose — tracing, datasets, scores, annotation queues; sole system of record (Cloud is an env-var fallback, `LANGFUSE_HOST`) |
| Serving | SSE streaming API, AWS App Runner, GitHub Actions CI |

## Corpora

| Corpus | Ingested | Golden set | Sources |
|---|---|---|---|
| Tenancy | v1 | v1 | RTA 2006, O. Reg. 516/06, LTB interpretation guidelines, annual rent-increase guideline (currency micro-source) |
| Insurance | v1 | v1 | Synthetic unit + master policy wordings (designed fixtures); your own via BYOD |
| Governing documents | v1 | v2 | Condominium Act 1998, O. Reg. 48/01, synthetic declaration/bylaws/rules (designed fixtures); real ones via BYOD |
| Selling | v1 | v2 | Condominium Act 1998 (status certificates), CAO guidance |

Statute and tribunal text is King's Printer for Ontario / Tribunals Ontario copyright, so the repo doesn't redistribute it: `corpus/raw/` is gitignored and rebuilt byte-identically by `pnpm corpus:fetch` from a committed **manifest** (`corpus/manifest.json` — source URLs, e-laws consolidation dates, checksums, licence notes per source). `pnpm corpus:verify` re-checks the already-fetched bytes against the manifest without the network, exiting nonzero with a per-source report on any drift. The manifest is also the corpus-versioning story — it records exactly which consolidation of each Act the published eval numbers were measured against. Only the designed fixtures (`corpus/fixtures/`, ours outright) are committed.

The ontario.ca / Tribunals Ontario CDN injects a per-request bot-detection script into every page, so the same statute served twice is not byte-identical. The manifest therefore records a per-source `normalization` policy; the only one in use, `strip-waf`, removes that injected line (it is not part of the legal source) before hashing and before writing, which is what makes the rebuild reproducible. The transport is `curl`, because the WAF hands Node's `fetch` an unstable client-side shell that omits the statute text. The checksum is over the normalized bytes, so a re-fetch on a clean checkout reproduces identical files.

The whole stack is ~2–3 MB of text — small enough that phasing by storage would be theater. What phases in is **eval coverage**: a corpus ships when its golden set does, and the table above says where each one stands. Synthetic fixtures are *designed*, not lorem ipsum: each plants specific teachable conflicts (a deductible-chargeback bylaw, a rule inconsistent with the declaration, an RTA-void lease clause), documented in a fixture-design note, so golden-set answers are ground truth by construction. Governing-doc golden questions are mined from published CAT (Condominium Authority Tribunal) decisions. Real personal documents never enter the repo — BYOD ingestion only.

## Build phases

- **Phase 0** — scaffold, corpus acquisition, synthetic fixture authoring (fixture-design note), Langfuse self-host stand-up (Docker volumes outside the synced drive folder), CONTEXT/ADRs ← *here*
- **Phase 1** — benchmark-first: eval harness skeleton + golden set v0 (tenancy) + the `naive-rag` baseline ship *before* chunker iteration, so the first real chunker PR lands with a scoreboard; then two-track ingestion of all four corpora, intrinsic ingestion evals + golden extraction set, Atlas indexes, retrieval debug endpoint, precision@k, report-only eval gate (PR score comments)
- **Phase 2** — LangGraph agent (full graph), `ChatVertexAI` provider wiring, SSE API (Agent SDK adapter for the product path = stretch/fallback)
- **Phase 3** — full eval harness, baseline pipelines (`stuff`/`naive-rag`), embedding/reranker A/Bs, governing/selling golden sets, results tables in this README
- **Phase 4** — AWS deploy, eval gate flips from report-only to blocking, demo UI polish

## Not legal advice

owners-manual explains what sources say and cites them. It does not recommend a course of action; questions that need one get the relevant information plus a pointer to the LTB, a lawyer, or your broker.
