# Fixture design

Every synthetic document in this directory exists to plant specific, teachable conflicts. A fixture is not sample data — it is a spec of an edge case the agent claims to handle, and golden/adversarial eval cases reference these conflicts by ID. Ground truth is known by construction: we know the right answer because we planted it.

Section numbers cited below are design intent; each gets verified against the current consolidation during golden-set authoring (no cite ships unverified — the project's own rule applies to its own docs). Verify markers read `— verify`.

## Provenance (why these conflicts are realistic)

Many entries below mirror conflicts found in a real Toronto condo corporation's document set (a 2024 OREA lease package and a downloaded governing-document library), captured privately and sanitized under `corpus/byod-inbox/` (gitignored — real documents never enter the repo). The fixtures here are freshly authored with invented identities and numbers; only the *shape* of each conflict is borrowed. The striking finding from that pass: a well-run building's real documents already contain invalid fines, misattributed restrictions, self-contradicting insurance restatements, and undefined load-bearing terms — so these planted conflicts are not contrived, they are typical.

## Entry format

- **ID** — referenced by eval cases
- **Fixture** — which synthetic document carries it
- **Planted conflict** — what the text says vs. what controls
- **Why it teaches** — the capability it exercises (authority ordering, void-clause detection, coverage-gap analysis, cross-corpus planning)
- **Eval hook** — the owner question it powers

## Document format (how fixtures are represented)

Fixtures are authored as **classless prose HTML5** and parsed by the deterministic `prose` family (ADR 0004; same parser as the LTB guidelines) into the typed document tree, so every fixture gets citable paths exactly like the real corpus and travels the identical ingestion pipeline (#12 registers them; intrinsic asserts — completeness, round-trip, fidelity — apply). Conventions the parser depends on:

- `<h1>` = document title (carried as the tree root label, not a content node).
- `<h2>` = sections, `<h3>` = subsections (shallowest content heading becomes the section tier). Headings MUST be classless — a `class` attribute marks a heading as page furniture and the parser drops it.
- `<p>` and `<li>` = citable `clause` nodes. Each planted conflict should live in its own paragraph/heading so it has a stable, referenceable citable path.
- No navigation, scripts, or styling — content only.

Byte layout under `corpus/fixtures/`:

```
fixtures/
  FIXTURE-DESIGN.md          ← this note (the spec)
  governing/
    declaration.html
    bylaw-standard-unit.html
    rules.html
    management-policies.html
  insurance/
    master-policy.html
    unit-policy.html
  tenancy/
    lease.html
```

## Shared synthetic facts (the cross-document contract)

All fixtures share ONE invented condo so cross-document conflicts line up. Every value here is fictional; none is the real corporation's. Authoring agents build to THESE numbers so the lease, declaration, rules, and policies stay mutually consistent.

- **Corporation**: Toronto Standard Condominium Corporation No. 9000 ("Harbourview Terrace"), 12 Fictional Crescent, Toronto, ON. Registered (fictional) 2020.
- **Pets** — Declaration: an owner may keep **up to two household pets**; a "pet" means a **cat or dog weighing no more than 20 kg**; service animals are exempt; the board may declare a pet a nuisance and require removal. (Rules later contradict this — see GOV-01.)
- **Pet — Rule (inconsistent)**: Rule purports to ban **all dogs over 10 kg** and **all dogs from the elevators**. Stricter than the declaration permits.
- **Standard unit** — defined ONLY in the standard-unit by-law as **builder-grade finishes**: vinyl plank flooring, laminate counters, builder-supplied appliances. Hardwood, stone counters, and upgraded/built-in appliances are **improvements**, excluded. The declaration *references* "standard unit" but does not define it (the gap that powers INS-01).
- **Master insurance policy**: insures the **standard unit and common elements** only; property limit (fictional) $50,000,000; **water-damage / sewer-backup deductible $25,000**; base property deductible $10,000. Covers sewer backup at the corporation level.
- **Deductible chargeback** — Declaration provision: where corporation insurance responds to damage **originating in an owner's unit**, that owner is liable for the policy **deductible, regardless of fault**, recoverable as a common-expense addition. (Mirrors the real no-fault chargeback finding; tension with Condo Act s. 105 — verify.)
- **Unit owner policy**: covers contents + **sudden and accidental escape of water from plumbing**; **excludes sewer backup** (no endorsement attached); **no improvements/betterments rider**.
- **Lease**: Ontario residential tenancy; rent (fictional) $2,000/month; the unit is in a condominium and the tenant agrees to comply with the declaration, by-laws, and rules (the cross-corpus bridge).
- **Fees (management policy sheet, no rule authority)**: move-in $300 refundable deposit + $150 non-refundable charge; visitor-parking "fine" $100 after two violations; BBQ restriction.
- **Short-term rental**: a **six-month minimum lease** appears in the Rules; the management policy sheet **misattributes** the restriction to the declaration (which is silent on STR). Powers GOV-05.

---

## Insurance fixtures (master policy + unit policy)

**INS-01 — Standard-unit gap.**
Fixture: `insurance/master-policy.html` (+ the standard-unit definition in `governing/bylaw-standard-unit.html`); `insurance/unit-policy.html` without an improvements rider.
Planted conflict: the corporation insures the *standard unit* only (Condo Act s. 99 — verify); the owner has hardwood and stone-counter upgrades, and the unit policy's improvements/betterments coverage is absent. Neither policy covers the upgrades.
Why it teaches: coverage-gap analysis across two policies with a precedence relationship, plus locating a definition (standard unit) that lives in a by-law, not the policy.
Eval hook: "A burst pipe ruined my hardwood floors — the corporation says that's not their problem. True?"

**INS-02 — Deductible chargeback (no-fault).**
Fixture: `insurance/master-policy.html` ($25,000 water/sewer deductible) + the chargeback provision in `governing/declaration.html`.
Planted conflict: corporation insurance repairs the damage, but the declaration charges the **deductible back to the owner whose unit was the origin, regardless of fault** (Condo Act s. 105 — verify). The answer to "who pays" is neither policy alone — it is a declaration provision interacting with a statute.
Why it teaches: the owner must be routed from "insurance" to "governing documents" to "statute"; the cross-corpus planner must fan out.
Eval hook: "A pipe burst in my unit through no fault of mine, the corporation repaired the hallway, and now they say I owe the $25K deductible. Can they do that?"

**INS-03 — Missing sewer-backup endorsement.**
Fixture: `insurance/unit-policy.html` — water-damage section covers sudden pipe escape but **excludes sewer backup**; no endorsement attached.
Planted conflict: the master policy covers sewer backup (at a $25,000 deductible the owner may be charged); the unit policy does not cover the owner's own contents/loss from sewer backup. Coverage falls in the gap.
Why it teaches: exclusion-reading — the agent must say "not covered, and here is the exclusion wording," not guess; and connect it to the master-policy deductible exposure.
Eval hook: "Storm backed up the drains and flooded my unit — am I covered?"

---

## Lease fixtures (residential tenancy agreement)

All in `tenancy/lease.html`. The lease is in a condominium and incorporates the declaration/by-laws/rules by reference (the bridge to the governing corpus).

**LEASE-01 — Void no-pets clause (cross-corpus).**
Planted conflict: a lease clause "no pets permitted" is void (RTA s. 14 — verify); but the synthetic declaration's pet provision (max two pets ≤ 20 kg) still binds the tenant through the condo pathway (RTA s. 76 / Condo Act s. 119 — verify), and the corporation can pursue removal of a non-permitted pet.
Why it teaches: void-clause detection PLUS the trap where the naive "that clause is void" answer is incomplete — the planner must fan out to governing documents.
Eval hook: "My lease says no pets but I got a cat anyway — can my landlord actually do anything?"

**LEASE-02 — Overbroad damages clause.**
Planted conflict: "tenant is responsible for all damage and repairs of any kind" collides with the landlord's repair duty (RTA s. 20 — verify) and the tenant's actual liability scope (s. 34 — verify). Not wholly void; its scope is cut down by statute.
Why it teaches: partial voidness — the clause survives only as far as the statute allows.
Eval hook: "The fridge died of old age and my landlord says the lease makes me pay. Does it?"

**LEASE-03 — "Voluntary" prepaid-rent rider.**
Planted conflict: a schedule says the tenant "voluntarily offers" to prepay two extra months of rent on move-in, applied to months 10–11. A lease *term* obligating prepayment beyond the lawful rent deposit is an illegal additional charge however it is labelled (RTA s. 105 / O. Reg. 516/06 — verify); the adverb "voluntarily" does the legal work and fails.
Why it teaches: adversarial — surface compliance ("voluntary") masking a prohibited term; the agent must look past the label.
Eval hook: "My lease says I volunteered to prepay months 10 and 11 — did I actually have to?"

**LEASE-04 — Conditional key deposit.**
Planted conflict: a $300 key deposit "returned after the tenant vacates and returns the unit in its original condition." Two layers: the amount may be defensible if it reflects fob/remote replacement cost (O. Reg. 516/06 — verify), but conditioning return on UNIT CONDITION converts it into a damage deposit, which is not permitted (RTA s. 105 — verify; a key deposit is returned on key return).
Why it teaches: layered analysis — half the clause is arguable, half is void; the agent must split them.
Eval hook: "My landlord kept my $300 key deposit because of a scuff on the wall — allowed?"

**LEASE-05 — $100-per-repair maintenance shift.**
Planted conflict: "tenant pays the first $100 of every repair to fixtures and appliances." This shifts the landlord's repair duty (RTA s. 20 — verify); the void-terms list treats requiring the tenant to pay for the landlord's repairs as unenforceable.
Why it teaches: partial voidness with a crisp dollar structure; distinguishes tenant-caused damage (chargeable, s. 34) from ordinary repair (not).
Eval hook: "My lease says I pay the first $100 of every repair and the dishwasher just died of old age — do I owe it?"

**LEASE-06 — Renewal-or-showings trap.**
Planted conflict: "if the tenant does not give 60 days' notice to renew, the landlord may show the unit to prospective tenants." Misunderstands fixed terms: a tenancy continues automatically at term end (RTA Part V — verify); showings to prospective *tenants* require a termination notice or agreement (s. 26(3) — verify); end-of-term is not termination.
Why it teaches: a composite misconception about fixed-term tenancies; the agent must correct the premise, not just the clause.
Eval hook: "I didn't give 60 days' renewal notice — can my landlord really start touring strangers through my home?"

**LEASE-07 — No-interest last-month deposit.**
Planted conflict: deposit framed as "first and last months' rent," held in trust, "no interest paid." A rent deposit may only be the LAST period's rent (RTA s. 105 — verify) and the landlord owes annual interest at the guideline rate (s. 106 — verify); collecting "first" as a deposit and disclaiming interest both fail.
Why it teaches: two embedded errors in one clause (deposit scope + interest entitlement).
Eval hook: "Three years into my tenancy — was I ever owed interest on my last-month deposit?"

**LEASE-08 — Enforceable-terms control pair (NOT a violation).**
Planted conflict: NONE — by design. A smoking restriction, a tenant-liability-insurance requirement, and a no-changing-the-locks clause are all enforceable (RTA s. 35 for locks — verify; smoking and insurance are permitted lease terms). This item exists to prove the agent does not over-flag: not every restrictive clause is void.
Why it teaches: precision — the discriminating behavior is telling enforceable from void, not flagging everything. Behavior class: answer, not flag-void.
Eval hook: "My lease bans smoking and makes me carry liability insurance — are those clauses even legal?"

---

## Governing-documents fixtures (declaration + by-law + rules + policy sheet)

Authority hierarchy under test: **Declaration > By-laws > Rules > management policy**, and the statutory ceiling above all of them (Condo Act 1998 — verify). Files: `governing/declaration.html`, `governing/bylaw-standard-unit.html`, `governing/rules.html`, `governing/management-policies.html`.

**GOV-01 — Rule inconsistent with declaration (pets).**
Planted conflict: the declaration permits up to two pets (cats/dogs ≤ 20 kg); a Rule purports to ban all dogs over 10 kg and bar dogs from elevators. Rules must be reasonable and consistent with the declaration (Condo Act s. 58 — verify); the inconsistent rule loses to that extent.
Why it teaches: the Declaration > Rules layer of the hierarchy, inside a single corpus.
Eval hook: "The new rules say no dogs over 10 kg but the declaration allows pets up to 20 kg — is my 15 kg dog allowed?"

**GOV-02 — Policy contradicts a declaration permission (BBQ).**
Planted conflict: the declaration expressly permits **electric** barbecues on exclusive-use balconies; a management policy sheet bans all barbecues outright. A lower instrument cannot extinguish a use the declaration grants (s. 58 — verify).
Why it teaches: a management policy is the weakest instrument; it cannot override a declaration grant.
Eval hook: "The BBQ policy says no barbecues at all, but the declaration says electric ones are fine on my balcony — who wins?"

**GOV-03 — Rule purporting to fine.**
Planted conflict: the parking Rule says a violator "shall be fined $100" and have it added to common expenses. Ontario condos have **no power to levy fines** (Condo Act — verify; enforcement runs through s. 134 / the CAT and cost-recovery with authority, not penalties).
Why it teaches: invalid-rule detection — distinguishing a true charge-back power from a prohibited penalty.
Eval hook: "The condo fined me $100 for a parking violation and added it to my fees — do I have to pay?"

**GOV-04 — Fee without authority (chargebacks).**
Planted conflict: a management policy sheet levies a $150 non-refundable move-in charge and a fob-reactivation fee, "collected as common expenses," with no by-law or declaration indemnity behind them. A corporation cannot impose arbitrary charges or lien them without authority (Condo Act s. 84 / s. 134 — verify; the *Amlani* pattern).
Why it teaches: chargeback-validity analysis — whether a fee has a lawful basis, and whether it can become a lien.
Eval hook: "The corporation added a $150 'fee' to my account after I moved in — can they really lien my unit over that?"

**GOV-05 — Short-term-rental ban misattributed.**
Planted conflict: the six-month minimum lease lives in the Rules; the management policy sheet claims the restriction comes from the declaration, which is silent on short-term rentals. The restriction is real but the cited source is wrong.
Why it teaches: cross-document provenance — the agent must verify *which instrument* actually carries a restriction, not accept a confident citation.
Eval hook: "Can I rent my unit on Airbnb for three months while I'm abroad, and where does the building's rule actually come from?"

**GOV-06 — Tenant-gatekeeping overreach ("deemed a trespasser").**
Planted conflict: a Rule deems a tenant a "trespasser" if the owner's leasing paperwork is not filed within 30 days, and blocks the tenant from booking the elevator/moving in until management receives the tenant's ID. Collides with the owner's actual (notice-only) obligation on leasing (Condo Act s. 83 — verify) and with the tenant's RTA possession rights; a condo cannot convert a lawful tenant into a trespasser.
Why it teaches: limits of rule-making authority against statute and against a tenant's RTA rights; an owner-landlord persona question.
Eval hook: "My tenant moves in Saturday but management says she's a 'trespasser' and can't book the elevator until I file her ID — can they block her?"

---

## Cross-corpus bridges (what makes the planner fan out)

- **Lease ⇄ Declaration (pets)**: LEASE-01's void clause is incomplete without the declaration's pet provision (GOV-01 baseline) and the RTA s. 76 condo pathway. The single contractual hook is the lease line "the unit is in a condominium and the tenant agrees to comply with the declaration, by-laws and rules."
- **Insurance ⇄ Declaration (deductible)**: INS-02's "who pays" lives in the declaration's chargeback provision, not either policy.
- **Insurance ⇄ By-law (standard unit)**: INS-01's coverage line is defined in `bylaw-standard-unit.html`, referenced but undefined in the declaration and the master policy.
- **Rules/Policy ⇄ Declaration (hierarchy)**: GOV-01/02/05 all require reading two instruments and applying precedence.

## Out of scope for the fixtures

By-laws beyond the standard-unit by-law (the real set had none downloadable); financial statements; meeting minutes; status certificates. The standard-unit by-law is included only because INS-01 structurally requires the definition to exist somewhere.
