# Mneme v1 — Read-time Contradiction `⊥` & Resolution (sub-milestone 2)

**Date:** 2026-05-26
**Status:** Approved (brainstorming)
**Canonical spec:** `mneme-spec-v0.2-consolidated.md` — §4.8 (contradiction detection `⊥` + resolution operators), §2.5 (subjective-logic bridge), §5.6 (combination rules), §4.9 (`⊕`).

## Context

The MVP shipped **write-time** contradiction (`src/write/contradiction.ts`: the cheap `(subject, key, scopeHash)` + `status=validated` + different-`valueHash` check with four policies). v1 sub-milestone 1 shipped the combination rules `⊕`. This sub-milestone adds the **read-time** side: detect contradictions *within a queried `Corpus`* and resolve them as part of the algebra.

This is the second of four v1 sub-milestones. It depends on `⊕` (`resolve_synthesize_belief` and per-group `combinedConfidences` consume `combine`). It is the substrate the bio cognitive layer's Wave 2 contradiction-triage gates on.

**Goal:** the core `[C]` §4.8 surface — `⊥_clusters`/`⊥_pairs` detection and the six core resolution operators — as pure in-memory `Corpus` algebra. `requiredTiers = {core}`.

**Builds on** the green slice-1 tree (360 tests). Reused: the algebra `Corpus`/`Claim` types (`src/algebra/types.ts`, `src/core/claim.ts`); `pointEstimate` (`src/core/confidence.ts`); `valueHash` (`src/core/value.ts`); `bindingFor` (`src/distribution/registry.ts`); the `⊕` combine + `RULE` constants (`src/distribution/{beta,rules}.ts`); `SOURCE_WEIGHT` (`src/write/source-weight.ts`).

## Approach

Mirror the spec's structure (§4.8): `⊥_clusters` is the **primary** detector; `⊥_pairs` and `derived_pairs` are projections of it (the spec states `⊥_pairs(C) ⊆ derived_pairs(⊥_clusters(C))`, in fact equality). Resolution operators are **pure in-memory `Corpus → Corpus` transforms** — exactly like the other algebra operators and `⊕_synthesizeAs`; they do NOT persist. "Deprecate" produces a new `Corpus` with the losing claims' `status` set to `"deprecated"` (composes with a downstream `σ_status=validated`); "mark/flag" appends a contradiction-artifact claim; "synthesize" appends a derived claim. Persisting any of this is the later derived-writes slice.

## Components

### 1. `src/algebra/contradiction.ts` — detection + types

Types (§4.8):
- `ConflictReason` = `"value-difference"` — the §4.8 binary conflict criterion. The spec's reason field is open-ended (`value-difference, status-conflict, …`); this slice's detector only emits `value-difference`, so the union is narrowed to that (no dead variants); other reasons are future work.
- `Resolution` — a small record describing an applied resolution (kind + resulting claim ids), attached to a pair when a resolver ran.
- `ContradictionPair { left: Claim; right: Claim; conflictReason: ConflictReason; resolution?: Resolution }`.
- `ContradictionCluster { triple: {subject, key, scopeHash}; valueGroups: Map<string, Claim[]>; totalClaims: number; distinctValues: number; agreementRatio: number; highestConfidenceGroup?: string; combinedConfidences: Map<string, Confidence> }` (keyed by `valueHash`).

Functions:
- `clustersOf(corpus, threshold): ContradictionCluster[]` — keep only claims whose effective/point confidence is `> threshold`; group by `(subject, key, scopeHash)`; within a triple, sub-group by `valueHash`. A triple with ≥2 distinct value groups is a cluster. `agreementRatio = largestGroupSize / totalClaims` (1.0 = consensus, 1/k = perfect k-way disagreement). `combinedConfidences[value]` = the value group's claims pooled via `⊕ rule_evidence_pooled` (agreeing claims are independent evidence accumulating for that value). `highestConfidenceGroup` = the value with the highest pooled point estimate (tie-broken by `valueHash` lexicographically).
- `pairsOf(corpus, threshold): ContradictionPair[]` — the pairwise form (conflict iff shared `(subject,key,scopeHash)`, different `valueHash`, both `> threshold`). Implemented as `derivedPairs(clustersOf(...))`.
- `derivedPairs(clusters): ContradictionPair[]` — projection: for each cluster, emit the `k×(k−1)/2` cross-value pairs (`conflictReason: "value-difference"`).

`threshold` is a parameter (supplied by the caller/façade from `CorpusDefaults.confidenceThreshold`), not a new corpus field.

### 2. `src/algebra/resolution.ts` — the five non-synthesis resolvers (no `⊕`)

Pure `Corpus → Corpus` (curried as `(conflicts) => (corpus) => corpus`):
- `resolveDeprecateLower(pairs)` — for each pair, deprecate the lower-`pointEstimate` claim (tie → deprecate the lexicographically-higher claim id).
- `resolveFlagForReview(pairs)` — append one contradiction-artifact claim per conflict (a `Claim` with a reserved key/subject recording the conflicting ids); originals untouched.
- `resolveKeepBoth(pairs)` — identity (both live).
- `resolveDeprecateMinority(clusters)` — deprecate claims in every non-largest value group; the largest group stays in force.
- `resolvePromoteConsensus(clusters)` — deprecate minority groups AND set the consensus (largest) group's claims to `status="validated"`.

Deprecation = a new `Corpus` (via `mapCorpus`) with the targeted claims' `status` set to `"deprecated"`; stored confidence/params are never mutated.

### 3. `src/algebra/synthesis.ts` — `resolve_synthesize_belief` (uses `⊕`)

`resolveSynthesizeBelief(clusters, rule = RULE.WEIGHTED_AVG) => (corpus) => Corpus`:
- Operates only on **binary** clusters (exactly 2 distinct value groups); multi-way (`k>2`) clusters are left untouched (that is `resolve_synthesize_belief_multi` `[P]`, deferred).
- For each binary cluster: fuse the two value groups' pooled confidences (`combinedConfidences`) via the chosen `⊕` `rule` (default `rule_weighted_avg` — trust/evidence-weighted opinion averaging; caller may pass any binary-supported rule) into one new in-memory derived `Claim`. The derived claim's `value` is the `highestConfidenceGroup`'s value; its `confidence` is the fused Beta; its `evidence` is the union of both groups' evidence; `subject`/`key`/`scope` from the triple.
- Resolves the contradiction: the two conflicting groups' claims are set `status="deprecated"` and the synthesized claim is appended. Returns the new `Corpus`. **Unpersisted**: the synthesized claim is a well-formed in-memory `Claim` with a freshly generated id (`newClaimId`) so downstream operators (γ, κ, σ) can consume it, but there is no adapter write and no recorded-sequence/provenance assignment — persistence is the derived-writes slice. (Same posture as `⊕_synthesizeAs`.)

## Scope boundaries (deferred — NOT this slice)

- `resolve_synthesize_belief_multi` `[P]` (Dirichlet, `k>2`) → v2 (needs the Dirichlet protocol binding).
- Persisting resolved/synthesized claims (`commit_derived`, `evaluationClock`, provenance) → derived-writes sub-milestone.
- Incremental/subscription cluster maintenance (§8) → detection runs over the in-memory corpus per query; no per-triple subscription state.
- Mixed-distribution clusters → `combinedConfidences`/synthesis require matching distribution types within a triple; a mismatch throws a typed error (consistent with `⊕`).

## Testing (pinned to §4.8)

- **Detection equality:** `pairsOf(C) ⊆ derivedPairs(clustersOf(C))` (equality); a binary cluster yields exactly one pair.
- **Cluster shape:** "3 support A, 1 B, 1 C" → `distinctValues=3`, `totalClaims=5`, `agreementRatio=0.6`, `highestConfidenceGroup` = the highest pooled value; a consensus triple (all same value) is NOT a cluster.
- **Selection commutes:** `clustersOf(σ_p(C))` only contains clusters whose claims are all in `σ_p(C)`; filtering removes but never creates conflicts.
- **Threshold:** a below-threshold claim does not participate in detection.
- **combinedConfidences:** two agreeing `Beta(3,2)` claims on value A pool to `Beta(5,3)` (the `evidence_pooled` law).
- **Resolvers (corpus effect):**
  - `resolveDeprecateLower`: the lower-point-estimate claim becomes `status="deprecated"`; the other unchanged.
  - `resolveKeepBoth`: identity.
  - `resolveDeprecateMinority`: minority-group claims deprecated; largest group untouched.
  - `resolvePromoteConsensus`: minority deprecated AND consensus claims `status="validated"`.
  - `resolveFlagForReview`: corpus gains one artifact claim per conflict; originals unchanged.
  - `resolveSynthesizeBelief` on a binary `Beta` cluster: appends one derived claim whose confidence is the `weighted_avg` fusion of the two groups' pooled opinions, deprecates the two originals; a `k>2` cluster is left untouched.

## Stack & conventions

TypeScript (ESM/NodeNext, strict), Vitest, Zod, better-sqlite3 — unchanged. Core `[C]` tier only. TDD mandatory; each operator pinned to the §4.8 behaviors above. Relative imports use explicit `.js` extensions; concurrent implementers commit with pathspec.
