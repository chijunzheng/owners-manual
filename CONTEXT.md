# owners-manual

The missing owner's manual for owning a condo. A multi-corpus agentic RAG system that answers an Ontario condo owner's questions — tenancy rights (as landlord or tenant), insurance coverage, governing documents, selling procedure — with section-level citations and an explicit refusal to guess. Built as a personal tool; architected to demonstrate production RAG/agent engineering in TypeScript.

## Language

### Corpora & documents

**Corpus**:
One ingested body of documents sharing a domain and authority chain (e.g. tenancy, insurance). v1 ingests all four (tenancy, insurance, governing documents, selling); golden-set coverage phases in per corpus — a corpus is "done" when its golden set ships, not when it's ingested.
_Avoid_: knowledge base, collection, index

**Corpus manifest**:
The committed record of every fetched source: URL, e-laws consolidation/currency date, checksum, licence note. Raw corpus text is never committed (Crown copyright); the manifest plus fetch script reproduce it, and it pins which version of each Act the eval numbers were measured against.
_Avoid_: lockfile, sources list

**Designed fixture**:
A synthetic document (declaration, bylaws, rules, policy wording, lease) authored to plant specific teachable conflicts — deductible-chargeback bylaw, rule inconsistent with the declaration, RTA-void lease clause — and documented in a fixture-design note. Committed to the repo; golden-set answers over it are ground truth by construction. Real personal documents stay BYOD-only, never committed.
_Avoid_: sample data, mock document

**Authority hierarchy**:
The legal precedence order among sources within and across corpora: Act > Regulation > Tribunal Guideline > policy wording/contract clause; within condo governing documents: Declaration > Bylaws > Rules.
_Avoid_: ranking, priority list

**Void clause**:
A lease or contract clause that is unenforceable because it conflicts with a statute (e.g. an RTA-prohibited term). The agent must say a clause is void and cite both the clause and the overriding section.
_Avoid_: invalid term, illegal clause

**Coverage gap**:
A loss scenario covered by neither the owner's unit policy nor the corporation's master policy (or shifted via deductible chargeback / standard-unit definition). The flagship insurance analysis the agent performs.

**Pin-cite**:
A citation that resolves to a specific section/subsection of a source document (e.g. "RTA s. 62(1)"), not just the document. Every legal claim in an answer requires one.
_Avoid_: reference, link

### Ingestion

**Document tree**:
The typed representation of one parsed source (Part → section → subsection → clause), zod-validated; every node carries a citable path. The canonical intermediate format — markdown is a derived render for human review, never the source of truth.
_Avoid_: markdown corpus, parsed doc

**Citable unit**:
The smallest document-tree node a pin-cite can address (e.g. s. 62(1)). Chunk boundaries must coincide with citable units — this is the chunker's correctness criterion, which is legal, not semantic.

**Tree-level enrichment**:
LLM pass over a whole document tree before chunking: cross-reference graph ("despite section 12" → edge), definitions index, amendment notes. Keyed to the tree hash, so it survives chunker changes. Ablated via its consumers (xref expansion, definitions-in-prompt), never as a blob.

**Chunk-level enrichment**:
LLM-written situating context attached to each chunk after chunking and prepended before embedding (contextual retrieval). Keyed to chunk hash + prompt version; the headline index-time ablation.

**Corpus build**:
The content-addressed output of one pipeline run — hash(source manifest + pipeline config). Every eval number pins to a build; two results are comparable only if their builds are known.
_Avoid_: ingestion run, index version

### Agent

**Guard**:
The entry node enforcing the jurisdiction boundary (Ontario only), topical scope (condo-ownership domains — off-topic questions get refuse-out-of-scope), prompt-injection screening of untrusted content, and the information-not-advice boundary.

**Planner**:
The node that emits a structured retrieval plan: which corpora to query, in what order, single- vs multi-hop. Plans are hop-capped, and all iteration in the agent is an explicit bounded graph edge (reformulate ≤1 at retrieve, one Critic re-retrieval) — never an open-ended ReAct scratchpad, so Guard/Critic always run and trajectories stay comparable across eval runs.

**Critic gate**:
The post-synthesis node that verifies every claim maps to a retrieved chunk; on failure it triggers one re-retrieval, then degrades the answer honestly rather than guessing.
_Avoid_: validator, checker

**Owner profile**:
Mongo-persisted facts about the user's own situation (unit, building, policy identifiers) injected as context across sessions. Distinct from session memory (conversation summary).

**Information-not-advice boundary**:
The product promise that answers explain what sources say and cite them, but never recommend a legal course of action; advice-seeking questions get information plus an escalation suggestion (LTB, lawyer, broker).

### Evaluation

**Golden set**:
Per-corpus rubric items, hand-verified, mined from authoritative worked examples (LTB interpretation guidelines, CAT decisions, designed-fixture conflicts). Each item carries a corpus (tenancy / insurance / governing / selling / cross-corpus — the dashboard slice and a stratum key for the **Dev/holdout split**), a behavior class (answer / refuse-jurisdiction / refuse-out-of-scope / refuse-advice-escalate / flag-void-clause), claim-level answer points (judged per point), required cites (matched hierarchically via citable paths — descendant satisfies ancestor), difficulty/persona tags, and mandatory provenance. An item nobody can trace doesn't ship. Cross-corpus items ship from v1 (the Planner's fan-out must be measured, not assumed); each item carries paraphrase variants scored as a separate robustness delta; v2 adds scripted multi-turn dialogues exercising session memory and the **Owner profile**.

**Score dashboard**:
The published shape of every eval result, per arm × slice: strict pass rate (headline — behavior match + all answer points + all required cites), point score (mean fraction of points credited), citation precision/recall (deterministic), cost/latency. Gate thresholds attach per metric; never collapsed into one blended scalar, and slices are never averaged together.
_Avoid_: overall score, composite metric

**Dev/holdout split**:
Stratified ~70/30 assignment of golden items (by corpus × behavior class), made at authoring time; paraphrase variants inherit their parent's side. Iteration and failure reading touch dev only; holdout runs at release tier. The published dev-vs-holdout divergence is the overfit detector — its job is detection, not precision. The assignment is **frozen** in a committed manifest and append-stable ([ADR 0007](docs/adr/0007-frozen-append-stable-dev-holdout-split.md)): a parent keeps its recorded side as the set grows, and a new parent appends into its stratum's remaining dev quota (defaulting to holdout) and is recorded in the manifest in the same change — a guard asserts the manifest lists every parent — so adding an item never migrates an already-assigned item across the seal.
_Avoid_: train/test split (nothing is trained — the leak is prompt iteration); regenerating the manifest to resolve a diff (that unseals the holdout)

**Retrieval hit rate**:
The deterministic pre-synthesis triage metric: the fraction of an item's required cites whose citable paths reached the candidate set, matched hierarchically with the same matcher as cite grading. Splits failures into retrieval's fault vs synthesis's fault. Each candidate carries stage-provenance tags (vector / BM25 / graph expansion / rerank survivor), so component value shows up as mechanism, not just outcome.
_Avoid_: recall@k (that counts chunks; this counts required cites)

**RAGAS context metrics**:
The two LLM-scored retrieval columns on the **Score dashboard** — context precision and context recall — computed for the RAG arms only (`naive-rag`, `agent`; the stuffing arms retrieve nothing, so the columns are blank, never zero). Reference-based: scored against a *reference answer* synthesized from an item's claim-level answer points, not against its cites ([ADR 0009](docs/adr/0009-ragas-context-metrics-anchored-on-answer-points.md)). The **semantic** counterpart to **Retrieval hit rate** — that metric asks structurally "did the cited provisions' paths reach the candidate set?" (exact hierarchical cite match); RAGAS context recall asks "is the verified answer's *meaning* present in the retrieved text?". Reported side by side and may diverge; neither is blended into the other, and neither scores the *produced* answer — grading the answer is the judge's job.
_Avoid_: answer faithfulness/correctness (those grade the generated answer — a different metric family); recall@k

**Adversarial set**:
Eval cases designed to make the agent fail safely, spanning six canonical sub-classes: jurisdiction traps (out-of-province), hallucination bait (nonexistent sections), injection attempts, void-clause conflicts, advice-seeking phrasings, and off-topic. The sub-class is a tag, not a sixth behavior class — every adversarial item still carries one of the five **Golden set** behavior classes (jurisdiction → refuse-jurisdiction, advice → refuse-advice-escalate, off-topic → refuse-out-of-scope, void → flag-void-clause, hallucination-bait → answer that asserts the absence and refuses to fabricate, injection → answer the legitimate question or refuse-out-of-scope) plus a corpus, so adversarial coverage cuts across every slice. The sub-class is recorded in an optional, value-checked `tags.adversarial` field (the six values live in `adversarial_subclass.py`, whose authority is this entry — no TS original); a guard test asserts every sub-class has ≥1 committed parent, so "represented from v1" is CI-enforced, not aspirational.

**Ablation ladder**:
The two-ladder decomposition of the naive-rag→agent gap over eight components in dependency order: cumulative build-up (what each component added on arrival) plus leave-one-out (what breaks if removed from the final system). A component big on build-up but small on knock-out was absorbed by later additions — a redundancy finding. Every off-state has a defined fallback; runs at milestones. Each component is classified by how its off-state is enforced on the deployed service: corpus-build (hierarchy chunks, contextual enrichment), a named query-time env switch (graph expansion, authority rerank, planner), or **unsupported/deferred** when no service off-switch exists yet (hybrid BM25 → #14, metadata filters → #41, critic → needs a critic-off switch). The planner's switch (`OWNERS_MANUAL_QUERY_REFORMULATION`) gates only the bounded reformulation, so planner-off means "no bounded reformulation (single retrieval pass)" — corpus routing still runs. The offline ladder model spans all eight components (the framework); only the five live-enforceable ones produce runnable rungs and derived-table rows, the three deferred ones are surfaced in the runbook (never faked), and every emitted live rung differs from the full-system config in build or env.

**Calibration slice**:
~20 golden items whose answer points are graded by a human. Judge–human agreement (Cohen's kappa) and judge–judge agreement are published numbers; the LLM judge is trusted exactly as far as this slice says, no further. Claude is the primary judge — cross-family by default since the product model is Gemini; Gemini is the same-family secondary judge on the slice.

**Variance audit**:
A ~15-item slice run ×5 per release to publish the per-arm run-to-run noise floor. All other runs are n=1 per item; arm gaps are paired-by-item with bootstrap CIs over items, and any gap inside the noise floor is labeled "within noise". Exists because current models expose no temperature control — variance is measured, not suppressed.
_Avoid_: flaky-test retry, stability check

**Disposition**:
The one-line verdict every failed item receives before the next experiment may launch: bug / rubric-wrong / known-limitation / noise. Lives in Langfuse as a categorical score set from an annotation queue; the harness pre-flight refuses to start a new experiment while the previous run's queue is non-empty. The committed failure digest is a release-time export — derived from Langfuse, never the primary record. Rubric-wrong dispositions are the golden set's own bug tracker.
_Avoid_: triage label, TODO comment

**Smoke slice**:
The fixed ~12-item subset run on every merge: all five behavior classes, every corpus, ≥1 cross-corpus item, drawn from stable-at-baseline items so a failure is signal, not flake. Scored with deterministic metrics only — the structured answer envelope makes behavior and cites machine-checkable without a judge. Composition is versioned (smoke-v1, smoke-v2, smoke-v3) and changes only at milestones (smoke-v3: the #22 corpus expansion made insurance and governing live-serviceable, so the slice added one item from each).
_Avoid_: sanity check, quick test

**Eval gate**:
The CI step that runs the eval suite and fails the merge on metric regression beyond threshold. Gates the `agent` pipeline only. Tiered: smoke (intrinsic ingestion asserts + the **Smoke slice**) per merge; full LLM-judge suite nightly/per-release; baseline matrix per release. Staged lifecycle: report-only (PR score-table comment) through Phases 1–2; blocking from Phase 3/4 once baselines stabilize.

**Golden extraction set**:
Hand-verified expected document subtrees for the hardest-to-parse sections (definitions, embedded tables, repealed-text markers) — the ingestion analog of the golden Q/A set. Designed-fixture tables are ground truth by construction.

**Stuffing baseline**:
The no-retrieval eval pipeline, in two arms: `stuff` (entire corpus in one context — nobody selects what the model sees; the honest no-RAG arm) and `stuff-oracle` (oracle-routed relevant corpus only — isolates the Planner's routing lift from within-corpus retrieval). Corpus selection is itself retrieval, so only `stuff` may be called "no RAG". All arms share the agent's output contract **and run the same product model** — arm gaps measure architecture, never model choice. Economically viable via context caching on fixed prefixes.
_Avoid_: long-context mode, no-RAG mode

**Naive-RAG baseline**:
Fixed-size chunks, vector-only top-k, no reranking, no agent graph — the tutorial pipeline. Exists to prove the hierarchy-aware chunking and authority-weighted reranking earn their complexity.

## Relationships

- A **Corpus** has exactly one **Authority hierarchy**; the reranker weights candidates by it
- The **Planner** selects one or more **Corpora**; cross-corpus questions (e.g. tenant-caused flood) fan out to several. A golden item's corpus follows its cites (one corpus → that corpus; several → cross-corpus), so a single condo-insurance conflict typically yields *both* an insurance-only item (reading the policy — an exclusion, or the policy deferring the deductible to the declaration) *and* a cross-corpus item (the full fan-out to the declaration + Condo Act). The insurance slice is narrow because the genuinely hard insurance questions are inherently multi-instrument
- The **Critic gate** rejects any answer claim lacking a **Pin-cite** into a retrieved chunk
- The **Guard** owns the **Information-not-advice boundary**; the **Adversarial set** tests it
- The **Golden set** and **Adversarial set** together feed the **Eval gate**
- The **Document tree** serves double duty: **Citable units** power retrieval *and* hierarchical cite grading — one artifact, two consumers
- Every golden-set question runs through four arms — **Stuffing baseline** (×2), **Naive-RAG baseline**, and the agent — so every published metric has a reference point, and paired arms attribute *where* lift comes from
- **Designed fixtures** plant the conflicts (**Void clause**, **Coverage gap**, chargeback) that the **Golden set** and **Adversarial set** reference by name
- **Chunk-level enrichment** consumes **Tree-level enrichment** outputs (situating context cites the definitions and xrefs found earlier); ablation flags attach to consumers, not producers
- Experiments split index-time (each arm = a new **Corpus build** + index) vs query-time (flag flips against the same build); the matrix leans on query-time dimensions because they're free
- LLM budgets split by workload shape: Gemini on Vertex (GCP credit) runs everything at runtime — the agent and all four arms; Claude (subscription/Agent SDK credit) runs everything offline — **Tree-level enrichment**, **Chunk-level enrichment**, and the primary judge

## Example dialogue

> **Dev:** "A tenant asks 'can my landlord raise rent 10%?' — does the **Planner** route that to one **Corpus**?"
> **Domain expert:** "Tenancy only. But 'my tenant's dishwasher flooded the unit below — who pays and can I evict?' fans out: tenancy for the eviction grounds, insurance for the **Coverage gap** analysis, and later governing documents for the deductible chargeback bylaw. Each claim in the merged answer still needs its own **Pin-cite**, and if the lease says 'tenant pays all damages' the answer must check whether that's a **Void clause** before relying on it."

## Flagged ambiguities

- "condo docs" was used loosely for both the governing-documents corpus and any document about the condo — resolved: **Corpus** names are tenancy, insurance, governing documents, selling; "condo docs" means the governing-documents corpus only.
- "memory" conflated conversation history with persistent user facts — resolved: session memory (summarized history) vs **Owner profile** (cross-session facts) are distinct mechanisms.
- The project is deliberately NOT a property-manager assistant (resident-facing STAN-style clone) — it is owner-side tooling with its own reason to exist; alignment with PropTech JDs is a consequence, not the purpose.
