# Frozen, append-stable dev/holdout split

Pins how the **Dev/holdout split** (CONTEXT.md; implemented in `evals/src/owners_manual_evals/golden_split.py`) stays stable as the golden set grows. The split seals a holdout from prompt iteration — its value as the overfit detector depends on an assigned item *never* moving across the seal — but the v1 multi-corpus authoring (#22) exposed that the assignment, as written, was not stable under additions.

## The bug it closes

The split is a deterministic, stratified ~70/30: within each (corpus, behavior class) cell, parents are ordered by `SHA-256(id)` and the first `round(0.7 · n)` go to dev. That sort-and-cut is **not stable as `n` grows** — adding one parent to a cell can shift the cut and push an existing parent across the dev/holdout line.

Concretely, authoring the GOV-06 cross-corpus item: the `(cross-corpus, flag-void-clause)` cell held exactly one parent — `flag-void-no-pets`, on dev, and the smoke gate's *only* live-serviceable cross-corpus anchor. Adding `flag-tenant-not-a-trespasser` re-split the cell 1-dev/1-holdout, and the digest order placed the newcomer first — **evicting `flag-void-no-pets` to holdout**. That both broke the committed `smoke-v2` slice (which names it as a dev item) and silently migrated an already-in-gate item into the sealed holdout, contaminating the overfit detector. An item that has been iterated on cannot later become a "held-out" measurement of overfitting to that iteration.

## Decision

Freeze the assignment in a committed manifest, and make growth append-only.

- **A committed manifest is authoritative.** `evals/fixtures/golden/split-manifest.yaml` records every parent's side at the freeze point. `assign_split` reads it by default (the safe default — every caller sees the sealed partition) and pins each listed parent to its recorded side.
- **New parents append, they never displace.** A parent absent from the manifest is *new*: it fills its stratum's remaining dev quota (`round(0.7 · n)` minus the frozen-dev already there) in `SHA-256(id)` order, and defaults to holdout once that quota is full. A frozen parent is never moved, so an addition can never evict one across the seal.
- **The algorithm and the freeze are testable apart.** With an empty manifest the rule reduces *exactly* to the pure ~70/30 stratified split, so the existing split tests still pin the algorithm (they assign synthetic ids absent from the manifest) and a separate suite pins the freeze (append-stability, the eviction-prevention case, quota fill order).
- **Paraphrases are unchanged.** Only parents participate; variants inherit their parent's side and are intentionally absent from the manifest.

## Consequences

- `flag-void-no-pets` stays dev (frozen); GOV-06 lands holdout. GOV-06 cites the Condo Act, which the live index does not hold, so it is not live-serviceable and was never smoke-eligible — holdout is its correct home.
- New items default to holdout-fill: the **holdout grows freely while dev stays a curated set**. Putting a new item on dev is now a deliberate manifest edit at a milestone, not an accident of how many siblings happen to share its stratum.
- Regenerating the manifest is a milestone act, gated by review. Regenerating it to "make a diff go away" would re-partition the seal and unseal the holdout — the manifest's header says so, and the freeze tests would not catch a wholesale regen, so this is a discipline the reviewer enforces.
- `assign_split` now performs a small disk read by default (the manifest); callers wanting the raw algorithm pass `frozen={}`. The fixtures locator is imported lazily, so importing the module stays free of the fixture machinery.

## Considered alternatives

- **Per-item hash threshold (`dev` iff `hash(id) % 100 < 70`).** Append-stable and manifest-free, but it reassigns *every* existing item — side becomes a function of the id's own hash rather than its rank in a stratum — a wholesale reshuffle that itself migrates items across the seal and abandons any guarantee that a small stratum is represented on both sides. Trading one migration for many is the opposite of what the seal needs.
- **Pick the new item's id so its digest sorts after the anchor.** Keeps `flag-void-no-pets` on dev with a one-character id tweak and no code change, but it is opaque (a reader cannot see why the id was chosen), fragile (renaming the anchor silently flips it), and a one-off — the next parent added to the cell faces the same eviction. A band-aid over the symptom, not the bug.
- **Defer the cross-corpus item.** Sidesteps the immediate break, but the instability is in the split, not the item: the same eviction recurs for the next cross-corpus item and for tenancy-expansion items whose strata also hold smoke anchors. Fixing the split once unblocks the whole authoring backlog.
- **Store the side on each golden item (a `split:` field).** Co-located and visible per item, but it pollutes the item schema with an orchestration concern and spreads the seal across every item file — a noisy diff that invites hand-editing one item at a time. A single manifest keeps the seal in one reviewable artifact. Revisit only if per-item provenance of the side becomes valuable.
