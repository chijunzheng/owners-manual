# Judge calibration anchored on per-answer-point agreement (blind, balanced, dev-sourced)

Pins HOW issue #19 validates the LLM judge before its point scores carry weight on the published dashboard — the "calibration slice" CONTEXT.md names but no code yet implements. Settles the unit of agreement, what the human labels, the slice sampling, the κ acceptance bands, the disagreement→golden-fix loop, and the judge-judge robustness check. Builds on [ADR 0008](./0008-judge-invocation-claude-cli-offline-batch.md) (the Claude binary per-answer-point judge), [ADR 0005](./0005-provider-split-vertex-gemini-runtime-claude-offline-batch.md) (Claude primary / Gemini secondary, cross-family), and [ADR 0007](./0007-frozen-append-stable-dev-holdout-split.md) (the frozen dev/holdout split).

## Forces

- The judge (ADR 0008) is the **only subjective dimension** on the dashboard: behavior-class match, citation precision/recall, retrieval hit rate, and strict pass's cite half are deterministic. So calibration measures exactly one thing — the judge's binary answer-point credit decision — and nothing deterministic needs human validation.
- The judge already persists a binary verdict PER answer point to every trace (`judge_point:<id>`, `judge_scores.py:30-52`). The natural agreement unit is that per-point binary, not an item roll-up: ~20 items × 3–5 points ≈ 60–100 decisions versus 20, and a per-point κ localizes WHICH points the judge mis-grades.
- **Cohen's κ collapses under prevalence**: a judge that credits 95% of points posts ~95% raw agreement and a near-zero κ — a measurement artifact, not unreliability. A slice with a balanced credited/not-credited base rate, and reporting agreement + prevalence beside κ, is the only honest presentation.
- **Blinding is load-bearing**: if the human sees the judge's verdict while labeling, κ measures suggestibility, not agreement.
- Calibration can find that an answer POINT is ambiguous (judge and human disagree because the rubric is unclear) — a `rubric-wrong` finding that edits the golden item. Editing must stay on the dev split; the holdout (ADR 0007) is sealed.
- "Trusted exactly as far as measured agreement says": κ is a published trust *label*, never silently a pass/fail gate; and the judge must not be iterated against the calibration slice until κ looks good (overfitting the instrument to its own test).
- Provider (ADR 0005): Claude is the cross-family primary judge; Gemini is the same-family secondary, reserved for this slice. Judge-judge agreement is a robustness probe, never averaged into the headline.

## Decision

1. **Unit — per-answer-point binary.** κ pairs the human's `human_point:<id>` ↔ the judge's `judge_point:<id>` on the same trace, pooled across all (item, point) decisions. The headline is **κ stratified by behavior class**; pooled κ and item-level strict-pass (`all_points_credited`) κ are secondary roll-ups.
2. **Slice — ~20 items, agent arm, dev only, stratified + balanced.** Draw from the **dev** split (holdout sealed; rubric fixes edit items), **agent-arm** answers (the headline arm), stratified by behavior class with a **floor of ≥3 per refusal class**, **parents only** (no paraphrase variants), targeting **≥60 point-decisions** with a deliberately balanced credited/not base rate (include items the agent answers well AND poorly). Selection frozen in `evals/fixtures/calibration/slice-manifest.yaml`, ordered by `SHA-256(item.id)` — the ADR 0007 reproducibility discipline.
3. **κ reporting — label, not gate.** Publish observed agreement, positive/negative prevalence, Cohen's κ, and κ's seeded-bootstrap CI (reuse `bootstrap.py`), per behavior class and pooled. Trust bands (Landis–Koch): **κ≥0.61** → judge trusted for the headline; **0.41–0.60** → published with the κ + disagreement analysis; **<0.41** → not trusted, revise rubric / judge prompt before publishing. Never a CI gate.
4. **Disagreement triage — three buckets, recompute once.** Every judge↔human mismatch is triaged: `rubric-wrong` (ambiguous point → edit the golden item on dev), `human-error` (relabel), `judge-error` (counts against the judge). Correct rubric-wrong + human-error **once**, recompute κ **once**, publish. Remaining rubric issues are logged for v2, never chased to inflate κ. Every correction is recorded in the labels artifact.
5. **Human labels are a committed artifact, captured blind.** `evals/fixtures/calibration/labels.yaml` — one row per (item, point) carrying question + agent answer + point text + a blank `human_credited`, and crucially **no judge verdict/rationale** (blinding). The labels file is the #19 deliverable ("the human labels are the artifact"); the derived κ/agreement land back in Langfuse (sole system of record) and the README.
6. **Judge-judge — three numbers, Gemini diagnostic only.** Run Gemini over the same answers; publish **κ(Claude↔human)** [primary trust], **κ(Gemini↔human)**, **κ(Claude↔Gemini)**. High judge-judge κ with low agreement-to-human flags a shared same-family bias (the failure ADR 0005's cross-family split exists to catch). Gemini is never averaged into the headline.
7. **Ordering — calibrate early, off the disposition gate.** Calibration is a small targeted run (agent arm over the slice + both judges) that runs **before** the full four-arm matrix spends GCP credit, on its own CLI path, **not** behind the #21 disposition pre-flight (that gate is for full experiments). Calibration's rubric-wrong edits go straight to the golden items, not the run-failure disposition queue.

## Consequences

- New pure, unit-tested modules: a **stratified seeded sampler** (extending `variance_audit.select_variance_slice`), a **blind labeling-sheet generator** (→ `labels.yaml`, asserted to omit any judge field), a **calibration module** (Cohen's κ, observed agreement, prevalence, per-class κ, bootstrap CI; pairs `human_point`↔`judge_point`), and a **disagreement-triage report + recompute-once driver**. The live Langfuse write-back of the κ scores is a thin live-by-design binding (uninstrumented, like the other live bindings).
- Committed `slice-manifest.yaml` + `labels.yaml` under `evals/fixtures/calibration/`. The README gains a calibration table (the three κ numbers + CI). Langfuse stores `human_point:<id>` + the run-level κ scores.
- The judge prompt/model is **frozen during calibration**; any post-calibration judge change re-opens #19 (the trust label is valid only for the judge it measured).
- Single annotator (the owner): κ is judge-vs-one-human, not vs-consensus — a stated limitation. A 5-item second-labeler overlap (human↔human κ, the reliability ceiling) is an optional add, flagged not required.

## Considered alternatives

- **Per-item κ (strict-pass roll-up) as the headline.** One decision per item — only ~20 observations, statistically thin, and blind to WHICH points the judge mis-grades. Kept as a secondary roll-up. Rejected as primary.
- **Calibrate on the holdout slice.** Tempting (it is what RELEASE grades), but calibration edits golden items on rubric-wrong findings, which would break the ADR 0007 holdout seal; and the judge's reliability is item-agnostic, so dev generalizes. Rejected.
- **Show the judge's verdict in the labeling sheet ("for context").** Voids the measurement — κ becomes suggestibility. Rejected; the sheet is blind by construction (and a test asserts it omits any judge field).
- **Iterate rubric → recompute until κ clears the bar.** Overfits the instrument to its own validation set; the published κ would be meaningless. Rejected in favor of one correction pass, one recompute.
- **Average Claude + Gemini into the headline judge.** Destroys the cross-family signal (ADR 0005) and hides same-family bias. Gemini stays diagnostic. Rejected.
- **Calibrate across all four arms.** More faithful to the full eval but 4× the labeling for ~20 items; the agent arm is the headline and item selection already balances the credited/not base rate. Deferred to v2 (cross-arm judge stability).

## Execution runbook

The decisions above settle WHAT calibration measures; this section pins HOW it is run on live-verify day, so the live procedure lives in the repo and **blind labeling is the only manual step**. The `calibrate` CLI (`evals/src/owners_manual_evals/calibration_cli.py`) is the live seam; every pure unit behind it is tested offline against fakes.

**Resolved execution design**

1. **Slice-only `calibrate run` is the input producer.** A small, targeted run — agent arm over the 20 frozen-slice items + both judges — produces the three input files, INDEPENDENT of the four-arm matrix. It never spends the four-arm GCP credit and never touches the #21 disposition queue (Decision 7: calibrate early, off the disposition gate).
2. **The blind sheet states the judge's verbatim credit criterion.** So the human grades the SAME construct the judge does. This is NOT a blinding violation: only the per-item judge verdict/rationale stays hidden. The criterion is sliced live from `judge._JUDGE_INSTRUCTION` (not a hardcoded copy), with a drift-guard test, so a future change to the judge's credit rule forces the sheet to follow.
3. **Single blind labeler** (the owner). κ is judge-vs-one-human, not vs-consensus — a stated limitation (an optional 5-item second-labeler overlap is the reliability ceiling, flagged not required).
4. **Calibrate-first sequencing.** Calibration runs BEFORE the full four-arm matrix spends GCP credit, on its own CLI path, off the disposition pre-flight gate.
5. **Honest-default triage.** `judge-error` is the default bucket; a relabel (`rubric-wrong` / `human-error`) needs a WRITTEN justification (enforced by the strict `corrections.yaml` parser, for every correction); corrections are applied ONCE and κ is recomputed ONCE (never iterate-to-target). **Every `rubric-wrong` correction ALSO obliges a committed golden-point edit** on the dev split (the clarified gold label), since the finding is the golden set's own bug; the holdout stays sealed (ADR 0007).
6. **The trust band is a published label, never a gate.** Landis–Koch bands (Decision 3) annotate the published κ; they never silently pass/fail a CI run.

**The six-step procedure**

1. `calibrate run --out-dir <dir>` — produce `answers.json` (the agent arm's answer per slice item), `claude.json` and `gemini.json` (the primary + secondary judge verdict maps over the SAME answers). `answers.json` is the single source of answer text fed to both judges and, next, to the sheet — so all three raters grade the identical answer.
2. `calibrate sheet --answers <dir>/answers.json --out labels.yaml` — emit the blind labeling sheet (one row per (item, point), the verbatim credit criterion in the header, no judge verdict anywhere).
3. **Blind-label** `labels.yaml` in place (the only manual step): set each `human_credited` true/false against the answer, applying the shared credit criterion, without consulting the judge.
4. `calibrate kappa --labels labels.yaml --judge claude.json --gemini gemini.json` — compute and publish the calibration table: κ(Claude↔human) with its seeded-bootstrap CI + trust band, observed agreement, prevalence, per-behavior-class κ, and the two Gemini diagnostic κ.
5. `calibrate triage --labels labels.yaml --judge claude.json --corrections corrections.yaml` — triage every judge↔human mismatch, apply relabels once, recompute κ once; prints BOTH the before-κ and after-κ tables, the per-bucket counts, and the written justifications. **Commit the golden-point edit for every `rubric-wrong` finding.**
6. **Publish.** Commit `labels.yaml` (the #19 deliverable) and the κ table; the live binding writes `human_point:<id>` + the run-level κ scores back to Langfuse (the sole system of record).

**What closes #19** (it stays open as a live-verify tracker until all of these land): `labels.yaml` committed under `evals/fixtures/calibration/`; the κ table published with the CI + observed agreement + prevalence + per-class κ; the judge↔judge κ (Claude↔human, Gemini↔human, Claude↔Gemini); the triage + recompute-once with BOTH the before-κ and after-κ shown; and the scores written to Langfuse.
