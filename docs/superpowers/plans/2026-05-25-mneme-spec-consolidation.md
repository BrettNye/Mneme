# Mneme Specification v0.2 (consolidated) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold `mneme-spec-v0.1.md` + `mneme-v0.1.1-errata.md` + `mneme-v0.2-expansion-revised.md` into one canonical, internally-consistent `mneme-spec-v0.2-consolidated.md`, preserving math and decision integrity.

**Architecture:** Single deliverable file, written section-by-section in TOC order (§0 → §12 → Appendices A–H). Serial top-to-bottom authoring naturally enforces the integrity ordering (the pinned α,β convention and the DistributionProtocol interface are written before anything that depends on them). A bash verification script (`spec/verify-spec.sh`) encodes the design's six integrity rules and runs as the final gate; each section task also runs a targeted grep anchor for its own content. Fragments are NOT used — one file, one coherent author pass.

**Tech Stack:** Markdown (deliverable). Bash + grep (verification). No application/host language — the spec is implementation-neutral by design.

**Companion design (authoritative):** `docs/superpowers/specs/2026-05-25-mneme-spec-consolidation-design.md` — read its §3 (version-mismatch / reconstruct-from-corrected rule), §5 (correction-application matrix), and §6 (verification rules) before starting. This plan references that matrix rather than restating it.

**Integrity rules that bind every task:**
- **Reconstruct from corrected sources only.** The confidence/distribution subsystem is absent from the v0.1 file; source it from errata §2/§7 and v0.2 §3. Never reintroduce a v0.1-era wrong formula.
- **No new audit.** Faithful merge. If a section surfaces a *new* inconsistency not already reconciled by the six audits, STOP and flag it — do not silently "fix" it.
- **Tier badges.** Every operator/type/rule carries exactly one of `[C]` Core, `[P]` Protocol-extension, `[Prof]` Profile.
- **Body reads as already-correct.** No "this was wrong, now fixed" language in the normative body; rationale and audit history live in Appendices E/F.

---

### Task 1: Initialize repo and scaffold the consolidated document

**Files:**
- Create: `mneme-spec-v0.2-consolidated.md`
- (Prerequisite) git repository at project root

- [ ] **Step 1: Initialize git if needed**

Run:
```bash
cd "C:/Users/brett/source/repos/My_Projects/Mneme"
git rev-parse --is-inside-work-tree 2>/dev/null || git init
git add mneme-spec-v0.1.md mneme-v0.1.1-errata.md mneme-v0.2-expansion-revised.md docs/
git commit -m "chore: track source specs and consolidation design/plan"
```
Expected: a commit is created (or "nothing to commit" if already tracked).

- [ ] **Step 2: Write the document scaffold**

Create `mneme-spec-v0.2-consolidated.md` with front matter, title, status line declaring it supersedes v0.1 + v0.1.1 errata + v0.2 expansion, the tier-badge legend, and the full TOC from design §4.1. Content:

```markdown
# Mneme Specification v0.2 (consolidated)

**Status:** Canonical. Folds and supersedes: Mneme v0.1 spec, v0.1.1 errata, v0.2 expansion (revised). Errata corrections are applied inline; capability additions integrated; erasure deferred (Appendix H).

**Tier legend:** [C] Core — every implementation MUST support. [P] Protocol extension — declared protocol, reference impl provided, opt-in. [Prof] Customer-gated profile — specified, not shipped.

**Implementation-neutral:** pseudocode notation; storage adapters named; no host language mandated (see §1.4, Appendix G).

## Table of contents
0. Conventions
1. Motivation and reframe
2. Core types
3. Catalog model
4. Query algebra
5. Distribution protocol [P]
6. Catalog operations
7. Write model
8. Subscription model
9. Access control integration
10. Storage adapter protocol
11. Worked queries
12. Glossary
Appendices: A Defaults · B Similarity functions · C Reserved scope fields · D Math re-derivations · E Design decisions · F Audit reconciliation history · G Deferred/out-of-scope · H Erasure profile [Prof]
```

- [ ] **Step 3: Verify scaffold present**

Run: `grep -Fq 'Mneme Specification v0.2 (consolidated)' mneme-spec-v0.2-consolidated.md && grep -Fq 'Tier legend' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): scaffold consolidated v0.2 spec (header, TOC, tier legend)"
```

---

### Task 2: Author the integrity verification script (the doc-scale failing test)

**Files:**
- Create: `spec/verify-spec.sh`
- Test: `spec/verify-spec.sh` run against the (incomplete) consolidated doc

- [ ] **Step 1: Write the verification script**

Create `spec/verify-spec.sh` implementing all six design §6 rules as named checks. This is the acceptance test for the whole document.

```bash
#!/usr/bin/env bash
# spec/verify-spec.sh — integrity gate for the consolidated Mneme spec.
set -uo pipefail
DOC="${1:-mneme-spec-v0.2-consolidated.md}"
fail=0
check(){ if [ "$1" -eq 0 ]; then printf 'PASS %s\n' "$2"; else printf 'FAIL %s\n' "$2"; fail=1; fi; }

# Rule 1 — deprecated-rule guard
! { grep -nE 'rule_max_confidence' "$DOC" | grep -vi 'deprecated' | grep -q .; }; check $? no-deprecated-rule
! grep -Fq 'sum the underlying Beta parameters' "$DOC"; check $? no-naive-pooling
# Rule 1b — wrong SL bridge form must be absent
! grep -Fq 'α / (α + β + W)' "$DOC"; check $? no-wrong-sl-bridge

# Rule 2 — worked-example numeric anchors
grep -Fq 'belief = (α−a·W)/(α+β)' "$DOC"; check $? sl-bridge-correct
grep -Fq 'uncertainty = W/(α+β)' "$DOC"; check $? sl-uncertainty
grep -Fq 'Beta(5,3)' "$DOC"; check $? worked-pooling
grep -Fq 'α_pooled = α₁ + α₂ − a·W' "$DOC"; check $? pooled-formula
grep -Fq 'Dirichlet(3, 1.2, 0.8)' "$DOC"; check $? extend-to-frame
{ grep -Eq '0\.55' "$DOC" && grep -Eq '0\.21' "$DOC"; }; check $? wilson-numbers
grep -Fq '0.793' "$DOC"; check $? migration-shift   # distinctive post-migration mean (errata §1.3); avoids false-match on "§2.4"
grep -Fq 'Beta(α=r+a·W, β=s+(1−a)·W)' "$DOC"; check $? rate-emits-beta

# Rule 3 — convention pinned
grep -Fq 'α = r + a·W' "$DOC"; check $? convention-pinned

# Rule 4 — tier tags present
{ grep -Fq '[C]' "$DOC" && grep -Fq '[P]' "$DOC" && grep -Fq '[Prof]' "$DOC"; }; check $? tier-tags

# Rule 5 — de-aliasing / new capability anchors
grep -Fq 'bimodal_approximation_warning' "$DOC"; check $? gaussian-bimodal
grep -Fq 'agreementRatio = largest_group_size / total_claims' "$DOC"; check $? cluster-ratio
grep -Fq 'integrity_unknown' "$DOC"; check $? replay-status
grep -Fq 'embeddingModelId' "$DOC"; check $? embedding-scope-field
grep -Fq 'valuePredicateSupport' "$DOC"; check $? value-predicate-matrix

# Rule 6 — no-orphan: each TOC section/appendix has a heading
for s in '## 0.' '## 1.' '## 2.' '## 3.' '## 4.' '## 5.' '## 6.' '## 7.' '## 8.' '## 9.' '## 10.' '## 11.' '## 12.' \
         '## Appendix A' '## Appendix B' '## Appendix C' '## Appendix D' '## Appendix E' '## Appendix F' '## Appendix G' '## Appendix H'; do
  grep -Fq "$s" "$DOC"; check $? "section-present:${s}"
done

exit $fail
```

- [ ] **Step 2: Run against the incomplete doc to verify it FAILS**

Run: `bash spec/verify-spec.sh mneme-spec-v0.2-consolidated.md; echo "exit=$?"`
Expected: many `FAIL` lines and `exit=1` (only the scaffold exists; content not yet written). This confirms the gate detects an incomplete doc.

- [ ] **Step 3: Sanity-check the script fails closed on an empty file**

Run: `printf '' > /tmp/empty.md && bash spec/verify-spec.sh /tmp/empty.md; echo "exit=$?"`
Expected: `exit=1`.

- [ ] **Step 4: Commit**

```bash
git add spec/verify-spec.sh
git commit -m "test(spec): add integrity verification gate (six design rules)"
```

---

### Task 3: §0 Conventions (pinned α,β convention)

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §0)
- Test: `bash spec/verify-spec.sh` checks `convention-pinned`, `tier-tags`

- [ ] **Step 1: Note the anchor (failing test)**

Run: `grep -Fq 'α = r + a·W' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §0**

Append `## 0. Conventions` from errata §1 + v0.2 §0.2. MUST include:
- §0.1 normative language (MUST/SHOULD/MAY).
- §0.2 tier model + badge legend (all three: `[C]`, `[P]`, `[Prof]`); `requiredTiers` declared on corpora, validated at deployment startup.
- §0.3 the foundational convention, verbatim: `α = r + a·W` and `β = s + (1−a)·W`; defaults `W = 2`, `a = 0.5`; no-evidence claim is `Beta(1,1)`; corpora MAY override W,a (recorded in catalog, propagated to combination ops); states every α,β-dependent operation is re-derived in Appendix D.
- §0.4 operator notation list.

- [ ] **Step 3: Verify**

Run: `grep -Fq 'α = r + a·W' mneme-spec-v0.2-consolidated.md && grep -Fq 'W = 2' mneme-spec-v0.2-consolidated.md && grep -Fq '[Prof]' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §0 conventions + pinned α,β"
```

---

### Task 4: §1 Motivation and reframe

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §1)

- [ ] **Step 1: Note the anchor**

Run: `grep -Fiq 'not a universal' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §1**

Append `## 1. Motivation and reframe` from v0.1 §1 + v0.2 §0 framing. MUST include:
- §1.1–1.3 the math-not-biology reframe (stateless functions; memory = input curation), preserved from v0.1 §1.
- §1.4 "What Mneme is and is not", **including the implementation-neutral statement**: pseudocode notation; named storage adapters (SQLite/Postgres/DuckDB/Chroma/Markdown vault); no host language mandated; reference-impl language deferred (Appendix G).
- §1.5 honest scope (enterprise AI-orchestration memory with audit-grade provenance; NOT a universal memory library).

- [ ] **Step 3: Verify**

Run: `grep -Fiq 'not a universal' mneme-spec-v0.2-consolidated.md && grep -Fiq 'implementation-neutral' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §1 motivation (incl. implementation-neutral note)"
```

---

### Task 5: §2 Core types (structural)

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §2.1–2.3, §2.6–2.8)
- Test: `verify-spec.sh` checks `replay-status`

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq 'scopeHash = "_"' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write the structural core types**

Append §2.1 Claim, §2.2 Subject/Key, §2.3 Scope, §2.6 Time, §2.7 Provenance, §2.8 EvidenceRef (from v0.1 §2 + errata §5/§8). MUST include:
- §2.3: empty-scope hash `scopeHash = "_"` (errata §8.4); `(profile, key, scopeHash)` is a **non-unique index**, unique PK is `id` (errata §8.5); cheap contradiction checks filter by status.
- §2.7 `DerivationProvenance` adds `similarityVersions`, `embeddingModelVersions`, `evaluationClock` (errata §5.2).
- §2.1 Claim references `Confidence` by type (math in §2.4); bitemporal `valid` + `recorded`.
- §2.8 evidence DAG acyclicity (no self-citation).
- `Confidence` referenced but NOT defined here (defined §2.4) — avoid duplication.

- [ ] **Step 3: Verify**

Run: `grep -Fq 'scopeHash = "_"' mneme-spec-v0.2-consolidated.md && grep -Fq 'non-unique index' mneme-spec-v0.2-consolidated.md && grep -Fq 'evaluationClock' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §2 structural core types (+errata §5/§8.4/§8.5)"
```

---

### Task 6: §2.4–2.5 Confidence and subjective-logic bridge (RECONSTRUCTED)

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §2.4–2.5)
- Test: `verify-spec.sh` checks `sl-bridge-correct`, `sl-uncertainty`, `no-wrong-sl-bridge`

INTEGRITY-CRITICAL: reconstruct from errata §2.2/2.3/2.4 — these are the only (corrected) versions that exist. Reproduce the corrected formulas exactly.

- [ ] **Step 1: Note the anchor (and confirm the wrong form is absent)**

Run: `grep -Fq 'belief = (α−a·W)/(α+β)' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §2.4–2.5**

Append §2.4 Confidence `[C]` and §2.5 SL bridge. MUST include, verbatim:
- §2.4: `distribution ∈ {beta, scalar, dirichlet, custom}`; effective mean `= α/(α+β)`; source weighting at promotion (table → Appendix A).
- §2.5 Beta→opinion (errata §2.2): `belief = (α−a·W)/(α+β) = r/(r+s+W)`; `disbelief = (β−(1−a)·W)/(α+β) = s/(r+s+W)`; `uncertainty = W/(α+β)`; `projected = α/(α+β)`.
- Worked vacuous opinion: `Beta(1,1)` under `W=2, a=0.5` ⇒ belief 0, disbelief 0, uncertainty 1, projected 0.5.
- Dirichlet generalization `[P]` (errata §2.3): `belief(xᵢ)=(αᵢ−aᵢW)/Σαⱼ`, `uncertainty=W/Σαⱼ`; W-scaling caveat for k>2.
- DS mass functions (errata §2.4): `mass({xᵢ})=belief(xᵢ)`, `mass(frame)=uncertainty`, `mass(∅)=0`.
- MUST NOT contain the wrong v0.1 form `α / (α + β + W)`.

- [ ] **Step 3: Verify**

Run: `grep -Fq 'belief = (α−a·W)/(α+β)' mneme-spec-v0.2-consolidated.md && grep -Fq 'uncertainty = W/(α+β)' mneme-spec-v0.2-consolidated.md && ! grep -Fq 'α / (α + β + W)' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §2.4-2.5 confidence + corrected SL bridge (reconstructed)"
```

---

### Task 7: §3 Catalog model

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §3)

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq 'scalarPseudocount' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §3**

Append §3.1 Corpus, §3.2 ClaimSchema, §3.3 CorpusDefaults, §3.4 AccessPolicy (v0.1 §3 + v0.2 §5.1 + errata §7). MUST include:
- `Corpus.requiredTiers: Set<TierRequirement>` with variants `core | protocol(name) | profile(name)` (v0.2 §5.1).
- `ClaimSchema.scalarPseudocount: Map<Source, Number>` and the rule that it is **required, no silent default** (errata §7).
- All v0.1 §3 fields preserved.

- [ ] **Step 3: Verify**

Run: `grep -Fq 'requiredTiers' mneme-spec-v0.2-consolidated.md && grep -Fq 'scalarPseudocount' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §3 catalog model (+requiredTiers, +scalarPseudocount)"
```

---

### Task 8: §4.1–4.7 Retrieval algebra operators

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §4.1–4.7)
- Test: `verify-spec.sh` value-predicate anchor exercised in §10

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq 'value.path' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §4.1–4.7**

Append §4.1 notation, §4.2 σ `[C]`, §4.3 π, §4.4 τ, §4.5 δ, §4.6 ρ+SimilarityFn, §4.7 γ (v0.1 §4 + errata §4.2/4.3). MUST include:
- §4.2 full predicate language incl. **value predicates** (errata §4): `value.path =,>,∈,matches,is null,exists`; whole-value `=,matches`; JSON-path (dotted, `[i]`, `[*]`; no recursive wildcard); parse-time type-check vs declared valueSchema.
- §4.4 all three τ variants + `τ_now`; §4.5 four decay policies; §4.6 `ρ` + `SimilarityFn` protocol; §4.7 `γ_d` with `γ_{d1}∘γ_{d2}=γ_{d1+d2}`.
- Each operator keeps equational laws + incremental-evaluation note.

- [ ] **Step 3: Verify**

Run: `grep -Fq 'value.path' mneme-spec-v0.2-consolidated.md && grep -Fq 'τ_known' mneme-spec-v0.2-consolidated.md && grep -Fq 'SimilarityFn' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §4.1-4.7 retrieval operators (+value predicates)"
```

---

### Task 9: §4.8 Contradiction detection and n-way clusters

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §4.8)
- Test: `verify-spec.sh` check `cluster-ratio`

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq 'agreementRatio = largest_group_size / total_claims' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §4.8**

Append §4.8 from v0.1 §4.8 + v0.2 §1. MUST include:
- `⊥_pairs : Corpus → Set<ContradictionPair>` `[C]` and `⊥_clusters : Corpus → Set<ContradictionCluster>` `[C]`.
- `ContradictionCluster` with `agreementRatio = largest_group_size / total_claims` (v0.2 §1.2).
- Resolution operators: `resolve_deprecate_minority`, `resolve_promote_consensus`, `resolve_synthesize_belief` `[C]` (binary, SL bridge), `resolve_synthesize_belief_multi` `[P]` (k>2, references Dirichlet §5.3).
- Law `⊥_pairs(C) ⊆ derived_pairs(⊥_clusters(C))`; streamable incremental evaluation.

- [ ] **Step 3: Verify**

Run: `grep -Fq 'agreementRatio = largest_group_size / total_claims' mneme-spec-v0.2-consolidated.md && grep -Fq 'resolve_synthesize_belief_multi' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §4.8 contradiction + n-way clusters"
```

---

### Task 10: §4.9–4.12 Combination and composition operators

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §4.9–4.12)
- Test: `verify-spec.sh` check `no-deprecated-rule`

- [ ] **Step 1: Note the anchor (deprecated rule must stay absent)**

Run: `grep -Fq 'rule_max_confidence' mneme-spec-v0.2-consolidated.md && echo PRESENT || echo ABSENT`
Expected: `ABSENT`.

- [ ] **Step 2: Write §4.9–4.12**

Append §4.9 ⊕ operators, §4.10 ⊳, §4.11 ⋈, §4.12 κ (v0.1 §4.9–4.12). MUST include:
- `⊕_dedupe : Corpus→Corpus`; `⊕_synthesize_as<S,K> : Corpus→Claim`; rule names referenced only as post-split set (`rule_weighted_avg`, `rule_evidence_pooled`, `rule_max_mean`, `rule_max_concentration`, `rule_dempster`); rule math deferred to §5.6; `rule_max_confidence` MUST NOT appear as a live rule.
- §4.10 ⊳ laws (associative, non-commutative, identity ∅); §4.11 ⋈ variants; §4.12 `κ ≡ β_budget ∘ φ_format ∘ δ_dedup_content`; `ComposedContext` marked terminal (non-corpus).

- [ ] **Step 3: Verify**

Run: `grep -Fq '⊕_synthesize_as' mneme-spec-v0.2-consolidated.md && ! grep -Fq 'rule_max_confidence' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §4.9-4.12 combination/composition operators"
```

---

### Task 11: §4.13 Aggregation operators

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §4.13)
- Test: `verify-spec.sh` check `rate-emits-beta`

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq 'Beta(α=r+a·W, β=s+(1−a)·W)' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §4.13**

Append §4.13 `[C]` from v0.2 §2. MUST include:
- `AggregateResult{ groups: Map<GroupKey, AggValue> }` with `rate(beta: Beta)`.
- Operators: `α_count`, `α_count_where`, `α_sum`, `α_avg`, `α_min`, `α_max`, `α_groupBy`, `α_custom`.
- `α_rate<num-pred, denom-pred>` emits `Beta(α=r+a·W, β=s+(1−a)·W)` using the corpus convention — explicitly NOT Laplace `+1/+1` (v0.2 §2.3); plus `α_binary_rate` sugar.
- Bridge `α_join_aggregate<corpus-field, aggregate-key, reweight-fn>`; Beta-aware reweights `reweight_multiply_mean`, `reweight_wilson_floor`.
- The false `α_groupBy∘α_groupBy` closed-form claim MUST be absent (v0.2 §2.6).

- [ ] **Step 3: Verify**

Run: `grep -Fq 'Beta(α=r+a·W, β=s+(1−a)·W)' mneme-spec-v0.2-consolidated.md && grep -Fq 'reweight_wilson_floor' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §4.13 aggregation (Beta-typed rate)"
```

---

### Task 12: §4.14 Optimizer-relevant laws

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §4.14)

- [ ] **Step 1: Note the anchor**

Run: `grep -Fiq 'freely reorderable' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §4.14**

Append §4.14 (v0.1 §4.13 + errata §3.3). MUST include: push σ down; push τ down; δ before confidence filters; hoist ρ after σ; `π_f∘π_g=π_{f∩g}`; memoize stable `τ_recorded(past)` slices; the corrected statement that **Dempster combinations are unconditionally associative ⇒ freely reorderable** (errata §3); the optimizer-is-separate-from-algebra note. The v0.1 "order-sensitive when conflict is high" hedge MUST be absent.

- [ ] **Step 3: Verify**

Run: `grep -Fiq 'freely reorderable' mneme-spec-v0.2-consolidated.md && ! grep -Fiq 'order-sensitive when conflict' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §4.14 optimizer laws (Dempster freely reorderable)"
```

---

### Task 13: §5.1–5.2 Distribution protocol interface

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §5.1–5.2)

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq 'is_idempotent(rule_id)' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §5.1–5.2**

Append `## 5. Distribution protocol [P]` header, §5.1 interface, §5.2 Beta/scalar binding (RECONSTRUCTED from v0.2 §3.2). MUST include:
- `DistributionProtocol<T>` with `serialize/deserialize/canonicalize`, `mean/variance/pdf`, optional `to/from_subjective_logic_opinion`, `combine(rule_id,a,b,params)`, `supported_rules()`, `is_idempotent(rule_id)`.
- §5.2 Beta/scalar reference binding `[C]`: `mean=α/(α+β)`; `combine` dispatches to §5.6; references §2.4–2.5 for the math (no restatement — DRY).

- [ ] **Step 3: Verify**

Run: `grep -Fq 'is_idempotent(rule_id)' mneme-spec-v0.2-consolidated.md && grep -Fq 'supported_rules()' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §5.1-5.2 DistributionProtocol interface + Beta/scalar"
```

---

### Task 14: §5.3 Dirichlet reference implementation

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §5.3)

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq 'rule_max_concentration' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §5.3**

Append §5.3 Dirichlet `[P]` (v0.2 §3.3 + errata §2.3). MUST include: per-category mean/variance, marginalization, SL bridge per §2.5; five rules with idempotence flags — `rule_weighted_avg` (✓), `rule_evidence_pooled` (✗, prior-W subtraction), `rule_max_mean` (✓), `rule_max_concentration` (✓, argmax Σαᵢ), `rule_dempster` (✗, via SL→mass). No `rule_max_confidence`.

- [ ] **Step 3: Verify**

Run: `grep -Fq 'rule_max_concentration' mneme-spec-v0.2-consolidated.md && grep -Fq 'rule_evidence_pooled' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §5.3 Dirichlet reference impl"
```

---

### Task 15: §5.4 Gaussian/Kalman reference implementation

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §5.4)
- Test: `verify-spec.sh` check `gaussian-bimodal`

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq 'bimodal_approximation_warning' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §5.4**

Append §5.4 Gaussian/Kalman `[P]` (v0.2 §3.4). MUST include the de-aliased pair:
- `rule_kalman`: `σ²=1/(1/σ₁²+1/σ₂²)`, `μ=σ²(μ₁/σ₁²+μ₂/σ₂²)`, NON-idempotent (precision-weighted fusion).
- `rule_weighted_avg`: `μ=Σwᵢμᵢ`, `σ²=w₁σ₁²+w₂σ₂²+w₁w₂(μ₁−μ₂)²`, IDEMPOTENT, trust weights (v0.1 §4.9) NOT precision; show idempotence check `G₁=G₂ ⇒ G(μ,σ²)`.
- `rule_max_concentration` (lowest-variance wins, idempotent); `rule_max_mean` (argmax μ, idempotent).
- `rule_dempster`, `rule_evidence_pooled` → NotSupported.
- `bimodal_approximation_warning` when `w₁w₂(μ₁−μ₂)² ≥ 2·(w₁σ₁²+w₂σ₂²)`.

- [ ] **Step 3: Verify**

Run: `grep -Fq 'w₁w₂(μ₁−μ₂)²' mneme-spec-v0.2-consolidated.md && grep -Fq 'bimodal_approximation_warning' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §5.4 Gaussian/Kalman (de-aliased, bimodal warning)"
```

---

### Task 16: §5.5 Mixed-distribution combination

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §5.5)
- Test: `verify-spec.sh` check `extend-to-frame`

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq 'Dirichlet(3, 1.2, 0.8)' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §5.5**

Append §5.5 `[P]` (errata §7 + v0.2 §3.5). MUST include:
- `scalar_to_beta(s,pseudocount,a): α=s·pc+a·W; β=(1−s)·pc+(1−a)·W`; pseudocount **required** (parse-time failure if absent).
- Standard conversions: scalar→Beta; Beta→Dirichlet (same frame, trivial); Beta/Dirichlet→SL opinion.
- `extend_to_frame`: strip prior `r=α−a_b·W_b`, `s=β−(1−a_b)·W_b`; then `α_A=r+a_A·W_t`, `α_B=s·(a_B/(1−a_A))+a_B·W_t`, `α_C=s·(a_C/(1−a_A))+a_C·W_t`.
- Worked example: `Beta(3,2)` (W=2,a=0.5) into {A,B,C} (a=.5,.3,.2; W=2) ⇒ `Dirichlet(3, 1.2, 0.8)`.
- Properties: raw-evidence preserving (r+s invariant); total concentration `= α+β` only if `W_t=W_b`; max-entropy-approximation caveat + hyper-opinion escape hatch.

- [ ] **Step 3: Verify**

Run: `grep -Fq 'Dirichlet(3, 1.2, 0.8)' mneme-spec-v0.2-consolidated.md && grep -Fiq 'pseudocount' mneme-spec-v0.2-consolidated.md && grep -Fq 's·(a_B/(1−a_A))' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §5.5 mixed-distribution (scalar→Beta, extend_to_frame)"
```

---

### Task 17: §5.6 Combination-rule catalog

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §5.6)
- Test: `verify-spec.sh` checks `worked-pooling`, `pooled-formula`, `no-deprecated-rule`, `no-naive-pooling`

INTEGRITY-CRITICAL: the rule_evidence_pooled Beta formula and the rule_max split are the two convention-propagation fixes (errata §10, §11).

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq 'α_pooled = α₁ + α₂ − a·W' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §5.6**

Append §5.6 (errata §3/§6/§10/§11 + v0.2 §3.3/3.4). MUST include:
- Beta `rule_evidence_pooled`: `α_pooled = α₁ + α₂ − a·W`, `β_pooled = β₁ + β₂ − (1−a)·W`; N-input: `α=(Σαᵢ)−(N−1)·a·W`; worked `Beta(3,2)⊕Beta(3,2)=Beta(5,3)`. The wrong "sum the underlying Beta parameters" MUST be absent.
- `rule_max` split (errata §11): `rule_max_mean` (argmax mean), `rule_max_concentration` (argmax concentration); `rule_max_confidence` appears ONLY as `DEPRECATED` with mandatory typed-error migration naming both replacements.
- Idempotence table: `weighted_avg ✓ | evidence_pooled ✗ | max_mean ✓ | max_concentration ✓ | dempster ✗ | kalman ✗`.
- Protocol-uniform-rule-name contract (same name ⇒ same semantic across distributions).

- [ ] **Step 3: Verify**

Run: `grep -Fq 'α_pooled = α₁ + α₂ − a·W' mneme-spec-v0.2-consolidated.md && grep -Fq 'Beta(5,3)' mneme-spec-v0.2-consolidated.md && grep -Fiq 'DEPRECATED' mneme-spec-v0.2-consolidated.md && ! grep -Fq 'sum the underlying Beta parameters' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §5.6 combination-rule catalog (pooled fix, rule_max split)"
```

---

### Task 18: §6 Catalog operations

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §6)

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq 'createCorpus' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §6**

Append §6 (v0.1 §5). MUST include: `createCorpus`/`updateCorpusSchema`/`updateCorpusPolicy`/`deleteCorpus`; `listCorpora`/`getCorpus`/`getCorpusSchema` (read ops respect access policy); multi-corpus queries reference corpora by name, access enforced per reference, result schema = union (or intersection for restrictive ops).

- [ ] **Step 3: Verify**

Run: `grep -Fq 'createCorpus' mneme-spec-v0.2-consolidated.md && grep -Fiq 'union' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §6 catalog operations"
```

---

### Task 19: §7 Write model

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §7)
- Test: `verify-spec.sh` check `replay-status`

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq 'integrity_unknown' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING` (until §7 or §2.7 introduces it — §2.7 added the field, this section adds ReplayStatus). If FOUND from §2.7, that's fine; this section adds the enum.

- [ ] **Step 2: Write §7**

Append §7.1–7.7 (v0.1 §6 + errata §5/§8). MUST include:
- §7.1 two-phase pipeline + correctness-vs-performance note (errata §8.3).
- §7.3 contradiction policies; cheap check filters by status (errata §8.5).
- §7.4 transactions, §7.5 batch, §7.7 idempotency (v0.1).
- §7.6 derived writes: `commit_derived` MUST populate `similarityVersions`/`embeddingModelVersions` for similarity-based queries else REJECT (errata §5.4); replay is version-conditional with `ReplayStatus ∈ {exact, unavailable_models, missing_inputs, integrity_unknown, failed}` (errata §5.3); v0.1-era derivations ⇒ `integrity_unknown`; the blanket reproducibility claim is replaced (errata §8.2).

- [ ] **Step 3: Verify**

Run: `grep -Fq 'integrity_unknown' mneme-spec-v0.2-consolidated.md && grep -Fiq 'MUST populate' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §7 write model (+mandatory version provenance, ReplayStatus)"
```

---

### Task 20: §8 Subscription model

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §8)

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq '⊥_clusters' mneme-spec-v0.2-consolidated.md | head -1; grep -c '⊥_clusters' mneme-spec-v0.2-consolidated.md`
Expected: count ≥ 1 from §4.8; §8 will add the streamability reference.

- [ ] **Step 2: Write §8**

Append §8 (v0.1 §7 + v0.2 §1.6/2.7). MUST include: subscribe primitive; trigger semantics (`on_every_match`/`on_transition`/`on_every_write`); delivery targets; at-least-once + causal ordering; backpressure policies; lifecycle; durable `SubscriptionState`. The streamability table MUST list `⊥_clusters` as streamable (v0.2 §1.6) and aggregation as **conditionally streamable** (count/sum/avg/rate yes; min/max add-only; groupBy if stable key — v0.2 §2.7), consistent with §4.8/§4.13.

- [ ] **Step 3: Verify**

Run: `grep -Fiq 'conditionally' mneme-spec-v0.2-consolidated.md && grep -Fiq 'at-least-once' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §8 subscriptions (+cluster/aggregation streamability)"
```

---

### Task 21: §9 Access control integration

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §9)

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq 'AuthorizationAdapter' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §9**

Append §9 (v0.1 §8). MUST include: `AuthorizationAdapter` (`canRead`/`canWrite`/`canSubscribe`/`canAdmin` → `allowed | denied(reason)`); enforcement at every read/write/subscribe/catalog op; decisions written to an audit corpus; row-level filtering (`canRead(principal,corpus,claim)` denials filter claims, query still succeeds).

- [ ] **Step 3: Verify**

Run: `grep -Fq 'AuthorizationAdapter' mneme-spec-v0.2-consolidated.md && grep -Fiq 'row-level' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §9 access control integration"
```

---

### Task 22: §10 Storage adapter protocol

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §10)
- Test: `verify-spec.sh` check `value-predicate-matrix`

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq 'valuePredicateSupport' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write §10**

Append §10 (v0.1 §9 + errata §4.4/4.5). MUST include: `StorageAdapter` ops; `AdapterCapabilities.valuePredicateSupport: Map<PredicateKind, ValuePredicateLevel>`; six `PredicateKind` (equality/range/set_membership/regex/structural_pattern/null_check); four `ValuePredicateLevel` (native_indexed/native_unindexed/fallback_in_memory/unsupported); the reference matrix (Postgres/DuckDB/SQLite/Chroma/Markdown); the "native_indexed ≠ all-predicates-cheap" caveat (Postgres regex = scan); backend-choice guidance (errata §4.5).

- [ ] **Step 3: Verify**

Run: `grep -Fq 'valuePredicateSupport' mneme-spec-v0.2-consolidated.md && grep -Fq 'fallback_in_memory' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §10 storage adapters (+value-predicate capability matrix)"
```

---

### Task 23: §11 Worked queries

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §11)
- Test: `verify-spec.sh` check `wilson-numbers`

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq 'reweight_wilson_floor' mneme-spec-v0.2-consolidated.md | head -1; grep -Eq '0\.55' mneme-spec-v0.2-consolidated.md && echo HAS55 || echo NO55`
Expected: `NO55` (the §11 example introduces it).

- [ ] **Step 2: Write §11**

Append §11 (v0.1 §10 five queries + v0.2 §2.5). MUST include: Q1 context assembly; Q2 multi-corpus layered (⊳); Q3 time-travel synthesis + derived write; Q4 streaming subscriptions; Q5 atomic completion writes; Q6 win-rate reweighting using `α_groupBy<scope.actionId, binary_rate<value.won>>` + `reweight_wilson_floor`, with corrected numbers: `22/30 ≈ 0.55` outranks `1/1 ≈ 0.21` (v0.2 §2.5). All queries use corrected operator/rule names.

- [ ] **Step 3: Verify**

Run: `grep -Eq '0\.55' mneme-spec-v0.2-consolidated.md && grep -Eq '0\.21' mneme-spec-v0.2-consolidated.md && grep -Fq 'reweight_wilson_floor' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §11 worked queries (corrected operators + win-rate)"
```

---

### Task 24: §12 Glossary

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append §12)

- [ ] **Step 1: Note the anchor**

Run: `grep -Fiq 'distribution protocol' mneme-spec-v0.2-consolidated.md | head -1; grep -c 'Glossary' mneme-spec-v0.2-consolidated.md`
Expected: glossary heading not yet present.

- [ ] **Step 2: Write §12**

Append §12 (v0.1 §12 + new terms). MUST include all v0.1 glossary terms plus: ContradictionCluster, AggregateResult, DistributionProtocol, subjective-logic opinion, tier (Core/Protocol/Profile), effective confidence. Each one-line definition consistent with its defining section.

- [ ] **Step 3: Verify**

Run: `grep -Fiq 'distribution protocol' mneme-spec-v0.2-consolidated.md && grep -Fiq 'cluster' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): §12 glossary"
```

---

### Task 25: Appendix A — defaults

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append Appendix A)

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq '## Appendix A' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write Appendix A**

Append `## Appendix A` (v0.1 App A + errata §7.3). MUST include: source-weight/half-life table (manual 1.3/180d, verification 1.2/90d, workflow 1.0/60d, heuristic 0.9/30d, llm 0.7/14d, imported 0.6/60d); pseudocount guidance (high-trust ≥10, medium ≈5, low ≈2; guidance only).

- [ ] **Step 3: Verify**

Run: `grep -Fq '## Appendix A' mneme-spec-v0.2-consolidated.md && grep -Fiq 'pseudocount' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): Appendix A defaults"
```

---

### Task 26: Appendix B — similarity functions

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append Appendix B)

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq '## Appendix B' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write Appendix B**

Append `## Appendix B` (v0.1 App B). MUST include the five standard similarity functions (`sim_cosine`, `sim_jaccard`, `sim_bm25`, `sim_exact`, `sim_structural`) with input types / range / cost, and the note they register per-corpus in `schema.similarities`.

- [ ] **Step 3: Verify**

Run: `grep -Fq 'sim_cosine' mneme-spec-v0.2-consolidated.md && grep -Fq 'sim_bm25' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): Appendix B similarity functions"
```

---

### Task 27: Appendix C — reserved scope fields

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append Appendix C)
- Test: `verify-spec.sh` check `embedding-scope-field`

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq '## Appendix C' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write Appendix C**

Append `## Appendix C` (v0.1 App C + errata §8.1). MUST include all v0.1 reserved fields (workflowName, runId, nodeId, personaId, teamId, entityType, entityId, topic, modelId) plus `embeddingModelId` (errata §8.1), and the no-shadow rule.

- [ ] **Step 3: Verify**

Run: `grep -Fq '## Appendix C' mneme-spec-v0.2-consolidated.md && grep -Fq 'embeddingModelId' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): Appendix C reserved scope fields (+embeddingModelId)"
```

---

### Task 28: Appendix D — math re-derivations (convention-propagation check)

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append Appendix D)

INTEGRITY KEYSTONE: every α,β-dependent operation re-derived with its derivation shown (errata §12.4), not asserted.

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq '## Appendix D' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write Appendix D**

Append `## Appendix D` (errata §12). MUST include the convention-propagation table covering: effective mean, SL bridge (Beta + Dirichlet), `rule_evidence_pooled` (Beta + Dirichlet), `rule_weighted_avg`, `rule_max_mean` (with the convention-dependent-ordering counter-example: Beta(8,0) vs Beta(2,0)), `rule_max_concentration`, `rule_dempster`, `rule_kalman`, `scalar_to_beta`, `α_rate`, `extend_to_frame` — each row showing its **derivation**, not a bare assertion. Include the `extend_to_frame` derivation (§12.3) and the future-revision process commitment (§12.4). The corrected `mean` row must NOT claim "prior cancels in ratio".

- [ ] **Step 3: Verify**

Run: `grep -Fq '## Appendix D' mneme-spec-v0.2-consolidated.md && grep -Fiq 'derivation' mneme-spec-v0.2-consolidated.md && grep -Fiq 'counter-example' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): Appendix D math re-derivations (convention-propagation)"
```

---

### Task 29: Appendix E — design decisions

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append Appendix E)

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq '## Appendix E' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write Appendix E**

Append `## Appendix E` (v0.2 §0.3 + errata §1.3/§11.6 + v0.2 §3.4/§4.1). MUST include rationale for: tiering; the rule_max split (why split not pin — errata §11.6); trust-vs-precision (why `rule_kalman` ≠ `rule_weighted_avg`); erasure deferral; the bimodal moment-match caveat; the three α,β migration options (accept shift / preserve mean / tag-and-defer — errata §1.3) with their threshold-shift consequences, **including the worked shift** `(8.2,1.4) mean 0.854 → (9.2,2.4) mean 9.2/11.6 = 0.793` (errata §1.3) — the `0.793` anchor is checked by the final gate.

- [ ] **Step 3: Verify**

Run: `grep -Fq '## Appendix E' mneme-spec-v0.2-consolidated.md && grep -Fiq 'trust' mneme-spec-v0.2-consolidated.md && grep -Fiq 'erasure' mneme-spec-v0.2-consolidated.md && grep -Fq '0.793' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): Appendix E design decisions"
```

---

### Task 30: Appendix F — audit reconciliation history

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append Appendix F)

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq '## Appendix F' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write Appendix F**

Append `## Appendix F` (v0.2 §7). MUST include the reconciliation tables for the v0.1 audit and the six v0.2 audit rounds (each finding → status), plus the accumulated process notes (third-audit wrong-direction fix; fifth-audit convention propagation; sixth-audit table-entry-as-claim) and the documentation discipline (every revision reconciles prior findings).

- [ ] **Step 3: Verify**

Run: `grep -Fq '## Appendix F' mneme-spec-v0.2-consolidated.md && grep -Fiq 'sixth audit' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): Appendix F audit reconciliation history"
```

---

### Task 31: Appendix G — deferred / out-of-scope

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append Appendix G)

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq '## Appendix G' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write Appendix G**

Append `## Appendix G` (v0.1 §11 + v0.2 §6.2). MUST include: v0.3-deferred items (federation; schema-migration tooling; cost models/optimizer internals; distributed multi-writer; library observability); v0.2 out-of-scope (consumer-scale ops budgets); and **reference-implementation language choice** as a deferred decision consistent with the §1.4 implementation-neutral statement. Catalogue only — no design.

- [ ] **Step 3: Verify**

Run: `grep -Fq '## Appendix G' mneme-spec-v0.2-consolidated.md && grep -Fiq 'federation' mneme-spec-v0.2-consolidated.md && grep -Fiq 'implementation language' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): Appendix G deferred/out-of-scope"
```

---

### Task 32: Appendix H — erasure profile (deferred)

**Files:**
- Modify: `mneme-spec-v0.2-consolidated.md` (append Appendix H)

- [ ] **Step 1: Note the anchor**

Run: `grep -Fq '## Appendix H' mneme-spec-v0.2-consolidated.md && echo FOUND || echo MISSING`
Expected: `MISSING`.

- [ ] **Step 2: Write Appendix H**

Append `## Appendix H — Erasure profile [Prof, DEFERRED]` (v0.2 §4). MUST include: status (specified, NOT shipped); architectural sketch (tombstones + preserved commitments; stratified replay tiers); the three blocking issues (HMAC+KMS not salt; GDPR hash-as-personal-data legal hole; 22–25-week cost); the banked v0.1.1 prerequisites (mandatory input hashing, model-version pinning, evaluationClock); trigger conditions; and the note that it is not part of the normative body.

- [ ] **Step 3: Verify**

Run: `grep -Fq '## Appendix H' mneme-spec-v0.2-consolidated.md && grep -Fiq 'DEFERRED' mneme-spec-v0.2-consolidated.md && grep -Fiq 'HMAC' mneme-spec-v0.2-consolidated.md && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md
git commit -m "docs(spec): Appendix H erasure profile (deferred)"
```

---

### Task 33: Final integrity gate

**Files:**
- Test: `spec/verify-spec.sh` against the complete `mneme-spec-v0.2-consolidated.md`

- [ ] **Step 1: Run the full gate**

Run: `bash spec/verify-spec.sh mneme-spec-v0.2-consolidated.md; echo "exit=$?"`
Expected: every line `PASS ...` and `exit=0`. (This is the same script that FAILed in Task 2 Step 2 against the scaffold — it now passes against the complete doc.)

- [ ] **Step 2: Fix any FAIL by targeted revision**

For each `FAIL <check>`, locate the responsible section (the check name maps to a task above), correct the section so the corrected formula/anchor is present and the wrong form absent, then re-run Step 1. Do NOT relax a check to make it pass.

- [ ] **Step 3: Confirm the four integrity-critical checks pass**

Run: `bash spec/verify-spec.sh mneme-spec-v0.2-consolidated.md | grep -E 'PASS (no-deprecated-rule|sl-bridge-correct|worked-pooling|convention-pinned)'`
Expected: four `PASS` lines.

- [ ] **Step 4: Final review against the design**

Re-read the consolidated doc against the design's correction-application matrix (design §5). Confirm every matrix row landed and no source content was dropped (except erasure → Appendix H, out-of-scope → Appendix G). Confirm the three source docs are no longer needed to read the spec.

- [ ] **Step 5: Commit**

```bash
git add mneme-spec-v0.2-consolidated.md spec/verify-spec.sh
git commit -m "docs(spec): consolidated v0.2 spec passes integrity gate"
```

---

## Notes for the engineer

- **Read the design first.** `docs/superpowers/specs/2026-05-25-mneme-spec-consolidation-design.md` §3/§5/§6 is the authoritative companion. When a task says "from errata §X", open the source doc and reproduce the corrected text.
- **Append in order.** Tasks 3→32 write sections strictly top-to-bottom. This is why the convention (§0) and the DistributionProtocol interface (§5.1) are written before anything that uses them.
- **The grep checks are tripwires, not correctness proofs.** They confirm anchors are present and wrong forms absent. Faithfulness and completeness are your responsibility (and the reviewer's) — a green grep is necessary, not sufficient.
- **Copy math anchors verbatim, including Unicode.** The grep checks match exact glyphs — `α β − (U+2212 minus, not ASCII hyphen) · ₁ ₂ ∈ ⊕ Σ`. If you write `a` for `α` or `-` for `−`, the gate fails even though the prose looks right. When a task quotes a formula string, paste it exactly.
- **If you find a NEW inconsistency** not reconciled by the six audits, STOP and surface it. This is a faithful consolidation, not a new audit round.
