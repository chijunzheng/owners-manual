# Judge invocation: local `claude -p` offline batch, one item per call

Pins HOW the Python offline judge (issue #18, `evals/src/owners_manual_evals/judge_live.py`) invokes Claude — the open question [ADR 0005](./0005-provider-split-vertex-gemini-runtime-claude-offline-batch.md) left as "`claude -p` / Agent SDK" without fixing the wire. The judge is the rubric-anchored BINARY per-answer-point scorer; this settles the route before the nightly judge tier and #19 (calibration slice) depend on it.

## Forces

- ADR 0005 bills the judge to the **Claude Max Agent SDK credit** ($100/month), cross-family by default (Claude judges the Gemini product), Gemini secondary on the calibration slice. That credit is tied to the `claude` login (a `claude setup-token`), NOT a pay-per-token API key.
- The judge is **offline batch, live-by-design, uninstrumented** — it runs over the verified golden set at milestones / nightly, never as a per-PR gate.
- #18 shipped the `JudgeClient` seam plus a PROVISIONAL `claude -p --output-format text` one-shot subprocess; the wire was explicitly not pinned.

## Decision

1. **Runtime — local / self-hosted offline batch on the subscription credit.** The judge runs where the `claude` login lives (the owner's machine, or a self-hosted runner authed with `claude setup-token`), not stock GitHub-hosted CI — which has no Max login. This keeps ADR 0005's credit model intact (zero marginal token cost) and matches the judge's milestone/nightly shape. Stock CI keeps only the deterministic metrics and the report-only smoke gate; the LLM judge is never a per-PR blocking gate.
2. **Wire — `claude -p` headless** (the credit-billed Agent SDK surface), not the Messages API — which would bill a separate pay-per-token key and contradict ADR 0005. The judge model is read from `JUDGE_CLAUDE_MODEL` (env), never hardcoded (fails loud if unset).
3. **Granularity — one item per call.** Each golden item is graded in its own invocation, preserving judging INDEPENDENCE (the judge never sees another item's answer, so no cross-item anchoring) and the clean per-item rubric → JSON contract; a malformed response fails only that item. Bounded concurrency MAY recover wall-clock, but independence is non-negotiable.
4. **Cost capture — `--output-format json`.** Read `total_cost_usd` + `usage` off the CLI envelope, and feed the envelope's `result` field into the existing `parse_judge_response` (which already strips a ```json fence and enforces one verdict per rubric point).
5. **Error handling — per-item timeout + bounded retry, then fail loud.** A per-item timeout (~120s) and a small retry budget (~2) on non-zero exit / timeout / malformed JSON; on persistent failure, RAISE for that item — never silently score it 0 (consistent with the parser's strict missing-point error). Record which items failed.
6. **Cross-family default preserved** [ADR 0005]: Claude (cross-family) is primary on all headline numbers; Gemini same-family is the secondary judge on the calibration slice only (#19).

## Consequences

- `judge_live.py` conforms: `_ClaudeCliJudge` switches to `--output-format json`, parses the envelope (cost/usage + `result`) through a pure, unit-tested helper, and wraps the subprocess in a timeout + bounded retry — still behind the `JudgeClient` seam, the offline scripted-fake suite unaffected.
- The "verified once against real Claude on a small slice" acceptance criterion is an OPERATOR step (needs the `claude` login + a produced answer to grade), like the Atlas re-ingest — not a CI job.
- A nightly judge tier, if automated, runs on a self-hosted runner authed with `claude setup-token`, or stays a manual milestone batch; it never becomes a GitHub-hosted CI job billing an API key.
- Per-run cost/usage is captured and can be logged to the run record / dashboard.

## Considered alternatives

- **Python Agent SDK (`claude-agent-sdk`), batched/async.** Native concurrency and structured usage, also creditable — but adds a dependency and an async batching layer for a ~69-item offline batch the subprocess loop already handles, and batching erodes per-item independence. Revisit only if throughput becomes a real constraint.
- **Anthropic Messages API (pay-per-token).** Cleanest structured/batched calls with native retries, but bills a separate API key — contradicting ADR 0005's subscription-credit model and spending real money while the $100/month credit sits idle. Rejected.
- **Run the judge in stock GitHub-hosted CI.** Every-nightly automation without the owner's machine, but the Max login cannot live in stock CI, so it forces an API key (the rejected Messages billing). Rejected in favor of local / self-hosted.
