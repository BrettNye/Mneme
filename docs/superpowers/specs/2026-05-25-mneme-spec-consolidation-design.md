# Design: Mneme Specification v0.2 (consolidated)

**Date:** 2026-05-25
**Type:** Document-consolidation design (no code)
**Status:** Approved structure; ready for implementation plan

---

## 1. Goal

Produce **one canonical, internally-consistent specification document** —
`Mneme Specification v0.2 (consolidated)` — that folds together three source
documents currently living in the repo root:

| Source | Role |
|---|---|
| `mneme-spec-v0.1.md` | Base spec: typed-algebra, catalog, write/subscription models, storage adapters, 5 worked queries |
| `mneme-v0.1.1-errata.md` | Bug-fix corrections to v0.1 (math + conventions + missing language) |
| `mneme-v0.2-expansion-revised.md` | Tiered capability additions (n-way clusters, aggregation, distribution protocol) + deferred erasure profile |

The overriding constraint is **integrity of the math and of the decisions**.
The consolidated doc must carry forward only post-audit-correct math, must not
lose the hard-won design decisions, and must be verifiable section-by-section
against the sources.

## 2. Decisions taken during brainstorming

1. **Artifact = consolidated spec document.** No code this session.
2. **Missing confidence/distribution subsystem is reconstructed from corrected
   sources.** (See §3.) Only post-audit math enters the doc.
3. **Clean normative body + rationale appendix.** Body reads as already-correct;
   the "why", audit history, and convention-propagation discipline live in
   appendices.
4. **Merge approach A** — keep v0.1's domain spine, fold errata inline as the
   correct form, tag features by tier, rationale to appendix.

## 3. The integrity-critical finding (version mismatch)

The errata and v0.2 repeatedly correct/extend a **confidence-and-distribution
subsystem** that does **not exist** in the `mneme-spec-v0.1.md` present in this
repo. The cross-references are stale:

| Referenced as living in v0.1 | What v0.1 actually has there |
|---|---|
| Subjective-logic bridge — errata §1/§2 → "v0.1 §4.4" | §4.4 = Temporal slicing τ |
| `DistributionProtocol` — v0.2 §3 → "v0.1 §4.6" | §4.6 = Similarity ranking ρ (`SimilarityFn`) |
| Mixed-distribution combination — errata §7 → "v0.1 §4.7" | §4.7 = Provenance traversal γ |
| Dirichlet / Gaussian / Kalman | absent entirely |

Grep confirms `mneme-spec-v0.1.md` contains no "subjective", "opinion",
"DistributionProtocol", "Dirichlet", or "mixed-distribution".

**Resolution (decided):** reconstruct the subsystem in the consolidated spec
**from the corrected errata/v0.2 content only**. Because no buggy v0.1 originals
of these formulas exist in the repo, there is zero risk of carrying a wrong
formula forward — the only versions available are the post-audit-correct ones:

- SL bridge (Beta → opinion) — errata §2.2
- Dirichlet generalization — errata §2.3
- Dempster-Shafer mass functions — errata §2.4
- scalar → Beta — errata §7.2
- `DistributionProtocol` interface — v0.2 §3.2
- Dirichlet / Gaussian / Kalman reference impls — v0.2 §3.3/§3.4
- `extend_to_frame` — v0.2 §3.5

All stale `§` pointers are rewritten to consolidated section numbers during the
cross-reference pass (§6, item 4).

---

## 4. Target document

**Identity:** `Mneme Specification v0.2 (consolidated)`. Status line declares it
supersedes and folds in v0.1 + v0.1.1 errata + v0.2 expansion.

**Tier badges:** `[C]` Core (every implementation MUST support) ·
`[P]` Protocol extension (declared protocol, reference impl provided) ·
`[Prof]` Customer-gated profile (specified, not shipped).

### 4.1 Table of contents

```
0. Conventions
   0.1 Normative language (MUST/SHOULD/MAY)
   0.2 Tier model + badge legend                          ← v0.2 §0.2
   0.3 Mathematical conventions: pinned α=r+a·W, β=s+(1−a)·W; W=2, a=0.5
                                                          ← errata §1, ELEVATED to foundation
   0.4 Operator notation (σ π ⋈ τ δ ρ γ ⊥ ⊕ ⊳ κ α_*)
1. Motivation and reframe                                 ← v0.1 §1 + v0.2 §0 honest-scope framing
2. Core types
   2.1 Claim                                              ← v0.1 §2.1
   2.2 Subject and Key                                    ← v0.1 §2.2
   2.3 Scope (+ empty-scope hash "_"; (profile,key,scopeHash) non-unique index)
                                                          ← v0.1 §2.3 + errata §8.4/§8.5
   2.4 Confidence (Beta, source weighting) [C]            ← v0.1 §2.4 (refs §0.3 convention)
   2.5 Subjective-logic bridge + Dirichlet + DS mass functions
       [C: Beta/scalar · P: Dirichlet]                    ← RECONSTRUCTED: errata §2.2/2.3/2.4
   2.6 Time (bitemporal)                                  ← v0.1 §2.5
   2.7 Provenance (+ similarityVersions, embeddingModelVersions, evaluationClock)
                                                          ← v0.1 §2.6 + errata §5.2
   2.8 EvidenceRef                                        ← v0.1 §2.7
3. Catalog model
   3.1 Corpora (+ requiredTiers)                          ← v0.1 §3.1 + v0.2 §5.1
   3.2 Claim schema (+ scalarPseudocount map)             ← v0.1 §3.2 + errata §7.2
   3.3 Corpus defaults                                    ← v0.1 §3.3
   3.4 Access policy                                      ← v0.1 §3.4
4. Query algebra
   4.1 Type-signature notation                            ← v0.1 §4.1
   4.2 Selection σ + value predicates [C]                 ← v0.1 §4.2 + errata §4.2/4.3
   4.3 Projection π                                       ← v0.1 §4.3
   4.4 Temporal slicing τ                                 ← v0.1 §4.4
   4.5 Decay δ                                            ← v0.1 §4.5
   4.6 Similarity ranking ρ + SimilarityFn                ← v0.1 §4.6
   4.7 Provenance traversal γ                             ← v0.1 §4.7
   4.8 Contradiction ⊥ pairs + ⊥_clusters (n-way) [C]     ← v0.1 §4.8 + v0.2 §1
   4.9 Belief combination ⊕ (operators; rule math → §5.6) ← v0.1 §4.9
   4.10 Layered override ⊳                                ← v0.1 §4.10
   4.11 Join ⋈                                            ← v0.1 §4.11
   4.12 Composition κ                                     ← v0.1 §4.12
   4.13 Aggregation: AggregateResult + α_* + bridge [C]   ← v0.2 §2
   4.14 Optimizer-relevant laws (+ Dempster reorderable)  ← v0.1 §4.13 + errata §3.3
5. Distribution protocol [P]
   5.1 DistributionProtocol interface                     ← RECONSTRUCTED: v0.2 §3.2
   5.2 Beta + scalar reference [C]                        ← v0.1 §2.4 + errata §1/§7
   5.3 Dirichlet reference impl                           ← v0.2 §3.3 + errata §2.3
   5.4 Gaussian + Kalman reference impl (+ bimodal warning)← v0.2 §3.4
   5.5 Mixed-distribution: scalar→Beta + extend_to_frame  ← errata §7 + v0.2 §3.5
   5.6 Combination-rule catalog: per-distribution semantics, idempotence table,
       rule_max split, evidence_pooled formula, protocol-uniform-naming contract
                                                          ← errata §3/§6/§10/§11 + v0.2 §3.3/3.4
6. Catalog operations                                     ← v0.1 §5
7. Write model
   7.1 Write pipeline (+ correctness-model/perf note)     ← v0.1 §6.1 + errata §8.3
   7.2 Visibility guarantees                              ← v0.1 §6.2
   7.3 Contradiction policies (+ status-filtered cheap check) ← v0.1 §6.3 + errata §8.5
   7.4 Transactions · 7.5 Batch writes                    ← v0.1 §6.4/6.5
   7.6 Derived writes (+ mandatory version provenance; version-conditional replay)
                                                          ← v0.1 §6.6 + errata §5.3/5.4/8.2 + v0.2 §5.3
   7.7 Idempotency                                        ← v0.1 §6.7
8. Subscription model (+ cluster & aggregation streamability) ← v0.1 §7 + v0.2 §1.6/2.7
9. Access control integration                             ← v0.1 §8
10. Storage adapter protocol (+ valuePredicateSupport matrix + backend guidance)
                                                          ← v0.1 §9 + errata §4.4/4.5
11. Worked queries (5 from v0.1 + aggregation win-rate; all on corrected operators)
                                                          ← v0.1 §10 + v0.2 §2.5
12. Glossary (+ cluster, aggregate, distribution protocol, opinion, tier)
                                                          ← v0.1 §12

Appendices
   A. Source-weight & decay defaults                      ← v0.1 App A
   B. Standard similarity functions                       ← v0.1 App B
   C. Reserved scope fields (+ embeddingModelId)          ← v0.1 App C + errata §8.1
   D. Mathematical conventions & re-derivations
      (convention-propagation check, with derivations shown) ← errata §12
   E. Design decisions & rationale
      (tiering, rule_max split, trust-vs-precision, erasure deferral, bimodal caveat)
                                                          ← v0.2 §0.3 + errata §9 + scattered
   F. Audit reconciliation history (six rounds)           ← v0.2 §7
   G. Deferred / out-of-scope (federation, migration, cost models, multi-writer, observability)
                                                          ← v0.1 §11 + v0.2 §6.2
   H. Erasure profile [Prof, DEFERRED]                    ← v0.2 §4
```

### 4.2 Key structural judgment calls (approved)

- **Combination-rule math lives in §5.6, not §4.9.** The ⊕ *operators*
  (`⊕_dedupe`, `⊕_synthesize_as`) are Core algebra; the *rule* math
  (`rule_weighted_avg`, `rule_evidence_pooled`, `rule_dempster`,
  `rule_max_mean`, `rule_max_concentration`, `rule_kalman`) is
  distribution-specific and sits with the distribution protocol. Beta/scalar
  rules are tagged `[C]` so core-only implementers have what they need.
- **The pinned α,β convention is promoted to §0.3** (foundation), because every
  confidence formula depends on it. This is what makes the
  convention-propagation check (Appendix D) enforceable.
- **Erasure is Appendix H**, marked deferred-profile — architectural sketch
  only, never in the normative body.

---

## 5. Correction-application matrix (master merge ledger)

Every errata correction and v0.2 addition, mapped to its destination. The merge
is complete iff every row is placed and verified.

### 5.1 Errata (v0.1.1) corrections

| Errata § | Correction | Destination |
|---|---|---|
| §1 | Pin α=r+a·W, β=s+(1−a)·W; W=2,a=0.5; migration semantic-shift documented | §0.3 (foundation) + §2.4 + Appendix E (migration options) |
| §2.2 | Corrected SL bridge (Beta→opinion); vacuous opinion property | §2.5 |
| §2.3 | Dirichlet generalization + W-scaling note for k>2 | §2.5 + §5.3 |
| §2.4 | Dempster-Shafer mass functions from SL opinion | §2.5 + §5.6 |
| §3 | Dempster unconditionally commutative + associative; non-idempotent | §5.6 (rule) + §4.14 (optimizer reorderable) |
| §4.2 | Value predicates added to selection language | §4.2 |
| §4.3 | Value-predicate equational laws | §4.2 |
| §4.4 | Per-(adapter, predicate-kind) capability matrix; PredicateKind/Level | §10 |
| §4.5 | Backend-choice guidance table | §10 |
| §5.2 | DerivationProvenance + similarityVersions/embeddingModelVersions/evaluationClock | §2.7 |
| §5.3 | Version-conditional replay; ReplayResult/ReplayStatus (incl. integrity_unknown) | §7.6 |
| §5.4 | Mandatory version provenance for derived writes | §7.6 |
| §5.5 | Irreversible-if-skipped note | §7.6 + Appendix E |
| §6.2 | Idempotence column on properties table | §5.6 |
| §6.3 | Observation-dedup mitigation guidance | §5.6 + §7.7 |
| §7.2 | scalar_to_beta with required pseudocount | §5.5 + §3.2 (scalarPseudocount) |
| §7.3 | Pseudocount recommended defaults | §5.5 + Appendix A |
| §8.1 | Reserved scope field `embeddingModelId` | Appendix C |
| §8.2 | §6.6 reproducibility language replacement | §7.6 |
| §8.3 | Write-pipeline correctness-vs-performance note | §7.1 |
| §8.4 | scopeHash of empty scope = "_" | §2.3 |
| §8.5 | (profile,key,scopeHash) non-unique index; status-filtered contradiction check | §2.3 + §7.3 |
| §9 | Summary-of-changes + required-actions list | Appendix F (history) + Appendix E |
| §10 | rule_evidence_pooled Beta: α_pooled=α₁+α₂−a·W; N-input generalization | §5.6 |
| §11 | rule_max_confidence → split into rule_max_mean + rule_max_concentration; per-distribution semantics; tie-breaking; breaking-change migration | §5.6 + Appendix E |
| §12 | Convention-propagation check table + extend_to_frame derivation + process commitment | Appendix D |

### 5.2 v0.2 additions

| v0.2 § | Addition | Destination |
|---|---|---|
| §0.2 | Three-tier commitment model | §0.2 |
| §0.3/0.4 | Honest-scope framing; what's deferred and why | §1 + Appendix E |
| §1 | N-way contradiction clustering (ContradictionCluster, ⊥_clusters, cluster resolution ops, resolve_synthesize_belief [C] / _multi [P]) | §4.8 |
| §2 | Aggregation (AggregateResult, α_count/sum/avg/min/max/groupBy/rate/binary_rate/custom, α_join_aggregate bridge, reweight fns, Beta-typed rate) | §4.13 |
| §2.5 | Win-rate reweighting worked example | §11 |
| §3.2 | DistributionProtocol interface | §5.1 |
| §3.3 | Dirichlet reference impl + rules | §5.3 + §5.6 |
| §3.4 | Gaussian/Kalman reference impl; trust-vs-precision; bimodal warning | §5.4 + §5.6 + Appendix E |
| §3.5 | Mixed-distribution conversion; extend_to_frame (base-rate split, max-entropy caveat) | §5.5 |
| §4 | Erasure semantics (deferred) | Appendix H |
| §5.1 | requiredTiers on Corpus + startup validation | §3.1 |
| §5.2 | Prior-findings audit discipline | Appendix F |
| §5.3 | Version-conditional reproducibility framing | §7.6 |
| §6 | Summary, backward-compat, acceptance, risk register | Appendix E + G |
| §7 | Prior-findings reconciliation (6 audits) | Appendix F |

---

## 6. Verification rules (run during the merge)

1. **Deprecated-rule guard.** `rule_max_confidence` and the wrong
   "sum the Beta parameters" pooling appear **only** as deprecated/superseded.
   A live use anywhere is a merge defect.
2. **Worked-example re-verification.** These numeric anchors must reproduce
   exactly in the consolidated text:
   - SL bridge: `Beta(1,1)` under W=2,a=0.5 → belief 0, uncertainty 1, projected 0.5
   - Pooling: `Beta(3,2) ⊕_pooled Beta(3,2)` = `Beta(5,3)` (mean 0.625), **not** Beta(6,4)
   - N-input pooling: three `Beta(3,2)` → `Beta(7,4)`
   - extend_to_frame: `Beta(3,2)` → `Dirichlet(3, 1.2, 0.8)` (a_A=.5,a_B=.3,a_C=.2,W=2)
   - Wilson floor: `22/30 ≈ 0.55` outranks `1/1 ≈ 0.21`
   - Migration shift: raw `(8.2,1.4)` mean 0.854 → `(9.2,2.4)` mean 0.793
   - scalar→Beta: scalar 0.8 with pseudocount 10 vs 100 give same mean, 10× weight
3. **Cross-reference rewrite.** Every stale source `§` pointer rewritten to
   consolidated numbering; every internal reference resolves to a real section.
4. **Convention-propagation table (Appendix D).** Each operator's formula in the
   body is verified against its re-derived form, with the derivation shown
   (not asserted — per errata §12.4: table entries are themselves claims).
5. **Tier-tag completeness.** Every operator, type, and rule carries exactly one
   tier badge; §0.2 legend matches usage; `requiredTiers` semantics consistent.
6. **No-orphan check.** Every matrix row (§5) lands in exactly one destination;
   no source content is silently dropped except where explicitly deferred
   (erasure → Appendix H) or out-of-scope (Appendix G).

---

## 7. Out of scope (this consolidation)

- Writing any implementation code.
- Resolving the deferred v0.3 items (federation, schema migration, cost models,
  distributed multi-writer, library observability) — catalogued in Appendix G,
  not designed.
- Building erasure — preserved as deferred sketch only (Appendix H).
- Changing any math or decision. This is a faithful consolidation, not a new
  audit round. If the merge surfaces a *new* inconsistency not already
  reconciled by the six audits, it is flagged for the user, not silently fixed.

---

## 8. Acceptance

The consolidated spec is complete when:
1. Every row of the correction-application matrix (§5) is placed.
2. All six verification rules (§6) pass.
3. The document reads as a single coherent spec with no "this was wrong"
   language in the normative body.
4. Appendices D/E/F preserve the math derivations, decision rationale, and audit
   history respectively.
5. The three source documents can be retired (or archived) without information
   loss.
