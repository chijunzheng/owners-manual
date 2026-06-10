# Fixture design

Every synthetic document in this directory exists to plant specific, teachable conflicts. A fixture is not sample data — it is a spec of an edge case the agent claims to handle, and golden/adversarial eval cases reference these conflicts by ID. Ground truth is known by construction: we know the right answer because we planted it.

Section numbers cited below are design intent; each gets verified against the current consolidation during golden-set authoring (no cite ships unverified — the project's own rule applies to its own docs).

## Entry format

- **ID** — referenced by eval cases
- **Fixture** — which synthetic document carries it
- **Planted conflict** — what the text says vs. what controls
- **Why it teaches** — the capability it exercises (authority ordering, void-clause detection, coverage-gap analysis, cross-corpus planning)
- **Eval hook** — the owner question it powers

## Insurance fixtures (unit policy + master policy)

**INS-01 — Standard-unit gap.**
Fixture: master policy + standard-unit schedule; unit policy without improvements rider.
Planted conflict: corporation insures the *standard unit* only (Condo Act s. 99 — verify); the fixture unit has hardwood and granite upgrades, and the unit policy's improvements coverage is absent.
Why it teaches: coverage-gap analysis across two policies with a precedence relationship.
Eval hook: "The flood ruined my hardwood floors — the corporation says that's not their problem. True?"

**INS-02 — Deductible chargeback.**
Fixture: master policy with $25,000 water-damage deductible + bylaw charging it back to the owner when damage originates in their unit (Condo Act s. 105 — verify).
Why it teaches: the answer to "who pays" is neither policy — it's a bylaw interacting with a statute.
Eval hook: "A pipe burst in my unit, the corporation repaired the hallway, and now they say I owe the $25K deductible. Can they do that?"

**INS-03 — Missing sewer-backup endorsement.**
Fixture: unit policy whose water-damage section covers sudden pipe escape but excludes sewer backup; no endorsement attached.
Why it teaches: exclusion-reading — the agent must say "not covered, and here is the exclusion wording," not guess.
Eval hook: "Storm backed up the drains and flooded my unit — am I covered?"

## Lease fixtures (residential tenancy agreement)

**LEASE-01 — Void no-pets clause (cross-corpus).**
Fixture: lease clause "no pets permitted"; synthetic declaration also restricts pets.
Planted conflict: the lease clause is void (RTA s. 14), but a condo declaration's pet provision still bites through the RTA's condo pathway (s. 76 — verify).
Why it teaches: void-clause detection PLUS the trap where the naive "that clause is void" answer is incomplete — the planner must fan out to governing documents.
Eval hook: "My lease says no pets but I got a cat anyway — can my landlord actually do anything?"

**LEASE-02 — Overbroad damages clause.**
Fixture: lease clause "tenant is responsible for all damage and repairs of any kind."
Planted conflict: collides with the landlord's repair duty (RTA s. 20) and the tenant's actual liability scope (s. 34 — verify).
Why it teaches: partial voidness — the clause isn't wholly void, its scope is cut down by statute.
Eval hook: "The fridge died of old age and my landlord says the lease makes me pay. Does it?"

## Governing-documents fixtures (declaration + bylaws + rules)

**GOV-01 — Rule inconsistent with declaration.**
Fixture: declaration permits up to two household pets; rules purport to ban all dogs.
Planted conflict: rules must be consistent with the declaration (Condo Act s. 58 — verify); the rule loses.
Why it teaches: the Declaration > Bylaws > Rules layer of the authority hierarchy, inside a single corpus.
Eval hook: "The board just passed a no-dogs rule but the declaration allows pets — which one wins?"

<!-- TODO(jason): owner's lived-experience pass — add 4-6 more GOV entries.
     You've actually read a declaration, sat through (or ignored) AGM notices,
     and asked real questions as an owner. The best fixtures come from questions
     you genuinely had, not ones a lawyer would invent. Use the entry format above.
     Prompts to jog memory: short-term rental (Airbnb) restrictions, EV charger
     installation, records requests to the corporation, special assessments,
     section 98 alterations to common elements, parking/locker assignment,
     status-certificate surprises when you bought. -->
