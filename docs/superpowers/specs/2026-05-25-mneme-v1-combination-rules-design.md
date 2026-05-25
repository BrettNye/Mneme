# Mneme v1 — Combination Rules `⊕` (sub-milestone 1)

**Date:** 2026-05-25
**Status:** Approved (brainstorming)
**Canonical spec:** `mneme-spec-v0.2-consolidated.md` — §4.9 (the `⊕` operators), §5.6 (per-rule math + idempotence table), §5.2 (Beta binding), §0.3 (the pinned α,β convention), §2.5 (subjective-logic bridge).

## Context

The MVP shipped the core algebra and distribution protocol with `combine()` **stubbed**: the Beta and scalar bindings return `∅` from `supportedRules()` and throw `"deferred to v1"` from `combine()`/`isIdempotent()`. This sub-milestone fills in the five core combination rules and adds the belief-combination operator `⊕` that consumes them.

This is the first of four v1 sub-milestones (the others — read-time `⊥`/resolve, derived writes + replay, aggregation α — are separate spec→plan→execute cycles). It is sequenced first because both read-time `resolve` (`resolve_synthesize_belief`) and any higher-layer synthesis/consolidation depend on `⊕`.

**Goal:** complete the §5.6 Beta contract (all 5 rules) and the §5.6 scalar contract (3 rules), plus the `⊕_dedupe` and `⊕_synthesize_as` algebra operators, all on the core `[C]` tier, `requiredTiers = {core}`.

## Approach

Keep the spec's protocol seam intact. **All per-rule math lives in each binding's `combine()`** — the algebra layer never branches on distribution type. The `⊕` operator orchestrates grouping and reduction over a `Corpus` and calls `binding.combine()` for the type-specific math. (Rejected alternative: a shared cross-binding rules module — adds indirection for only two bindings, where scalar is trivial.)

## Components

### 1. `src/distribution/beta.ts` — fill in `combine()` for all 5 rules

`Beta = { alpha: number; beta: number }`. Pinned convention (§0.3): `α = r + a·W`, `β = s + (1−a)·W`, default `W = 2`, `a = 0.5`. Math per §5.6:

- **`rule_weighted_avg`** — trust-weighted parameter average with weights normalized to sum 1:
  `α = Σᵢ wᵢ·αᵢ`, `β = Σᵢ wᵢ·βᵢ`. Because `Σ wᵢ = 1`, exactly one prior is carried through. **Idempotent ✓** (averaging `(α,β)` with itself returns `(α,β)`).
- **`rule_evidence_pooled`** — additive evidence pooling with prior-`W` subtraction:
  pairwise `α = α₁ + α₂ − a·W`, `β = β₁ + β₂ − (1−a)·W`;
  N-input closed form `α = (Σ αᵢ) − (N−1)·a·W`, `β = (Σ βᵢ) − (N−1)·(1−a)·W`.
  **Non-idempotent ✗** (pooling accumulates evidence; consumers dedupe by `observation_id` first).
- **`rule_max_mean`** — argmax over `α/(α+β)`; tie-broken by claim id. **Idempotent ✓**.
- **`rule_max_concentration`** — argmax over total concentration `α+β`; tie-broken by claim id. **Idempotent ✓**.
- **`rule_dempster`** — Dempster's rule of combination over subjective-logic mass functions: convert each `Beta(α,β)` to an opinion via the existing SL bridge (`betaToOpinion`, §2.5), apply Dempster's rule with conflict normalization, convert back (`opinionToBeta`). Commutative and associative with the vacuous opinion as identity. **Non-idempotent ✗**.
- `supportedRules()` → `{weighted_avg, evidence_pooled, max_mean, max_concentration, dempster}`.
- `isIdempotent(ruleId)` → per the §5.6 table (true for weighted_avg/max_mean/max_concentration; false for evidence_pooled/dempster).

### 2. `src/distribution/scalar.ts` — fill in `combine()` for the 3 supported rules

`Scalar = { p: number }`. Supports `rule_weighted_avg` (weighted average of the point values, weights from params), `rule_max_mean` (argmax `p`), `rule_max_concentration` (degenerate — all scalars share variance 0, so concentration ties break by claim id, per §4.9). `rule_evidence_pooled` and `rule_dempster` are **NotSupported** (both require an evidence total a bare scalar lacks). All three supported rules are **idempotent ✓**. `supportedRules()` returns the 3; `isIdempotent()` is true for each.

### 3. `src/distribution/rules.ts` (new) — rule-id constants + deprecation guard

Exports the canonical rule-id strings and `assertNotDeprecatedRule(ruleId)`: referencing the removed `rule_max_confidence` throws a **typed error** naming *both* replacements (`rule_max_mean` for point-estimate selection, `rule_max_concentration` for evidence-weight selection) and stating the semantic distinction (§5.6 MUST — silent migration to either is forbidden).

### 4. `src/algebra/combination.ts` (new) — the `⊕` operator

- **`oplusDedupe(ruleId, params?): Corpus → Corpus`** — group claims by `(subject, key, scopeHash)`; combine each group via the bound `combine()`; emit one claim per group (no within-key duplicates). The protocol's `combine(ruleId, a, b, params)` is pairwise, so the operator **folds each group left-to-right**: `evidence_pooled` folds exactly by associativity (§5.6 confirms pairwise pooling equals the N-ary closed form); the max rules fold as a pairwise argmax with claim-id tie-break; `rule_weighted_avg` threads the accumulated source-weight through `params` at each fold step so the result equals the full normalized weighted average. For `rule_weighted_avg`, per-claim weights default to `SOURCE_WEIGHT[claim.source]` (Appendix A, already in `src/write/source-weight.ts`); `params` may override.
- **`oplusSynthesizeAs(subject, key, ruleId, params?): Corpus → Claim`** — combine **all** input claims into one synthesized in-memory `Claim`: confidence from the rule, `evidence` = union of inputs' evidence, `scope` = the inputs' shared scope fields, `subject`/`key` as given. **Returns a `Claim` value; does not persist.** Persisting it (assigning id/recorded/provenance via `commit_derived`) is the separate derived-writes sub-milestone.

Both operators run on the core in-memory `Corpus`; both call `assertSupportsRule` (existing) so an unsupported rule on a binding fails with a clear typed error before evaluation, and route the deprecated `rule_max_confidence` through `assertNotDeprecatedRule`.

## Equational laws (§4.9, enforced by tests)

- `⊕_dedupe` is **associative** for the symmetric rules (`rule_weighted_avg`, `rule_evidence_pooled`).
- `⊕_dedupe` is **idempotent** for `rule_weighted_avg`, `rule_max_mean`, `rule_max_concentration`; **not** for `rule_evidence_pooled`, `rule_dempster`.
- `⊕_synthesize_as` is single-shot — no idempotence.

## Scope boundaries (deferred — NOT this slice)

- **Persisting** synthesized claims (`commit_derived`, derived-write provenance, `evaluationClock`) → derived-writes sub-milestone.
- **Mixed-distribution** combination (§5.5, e.g. Beta⊕scalar) → `combine` requires matching distribution types; a mismatch throws a typed error.
- **Per-corpus tie-breaker override** → default lexicographic-on-claim-id only (the spec allows an override; YAGNI for this slice).
- **Dirichlet / Gaussian** bindings and their rules (incl. `rule_kalman`) → v2 (protocol/profile tiers).
- The `⊳` join/compose operator and aggregation α (§4.13) → later slices.

## Testing (pinned to spec worked examples)

- **evidence_pooled (the slice's marquee test):** `Beta(3,2) ⊕ Beta(3,2) = Beta(5,3)` (mean 0.625, concentration 8). Three inputs → `Beta(7,4)` (matches pairwise, confirming associativity). Naive parameter sum `Beta(6,4)` is explicitly wrong (phantom prior).
- **idempotence:** `x ⊕ x = x` for weighted_avg/max_mean/max_concentration; `≠` for evidence_pooled/dempster. `isIdempotent()` matches the §5.6 table for both bindings.
- **max split divergence:** `Beta(9,1)` (mean 0.9, conc 10) vs `Beta(80,20)` (mean 0.8, conc 100) → `rule_max_mean` selects the first, `rule_max_concentration` the second.
- **weighted_avg:** weights normalized; trust-weighting via `SOURCE_WEIGHT`; verify one prior carried (sum of weights = 1 keeps `α+β` prior-correct).
- **dempster:** vacuous opinion is identity; commutativity (`m₁⊕m₂ = m₂⊕m₁`); a Zadeh high-conflict case (two sources favoring opposite singletons) combines sanely under conflict normalization.
- **scalar:** weighted_avg/max_mean/max_concentration work; evidence_pooled & dempster return NotSupported.
- **deprecation:** referencing `rule_max_confidence` throws a typed error naming both replacements.
- **operators:** `⊕_dedupe` collapses same-`(subject,key,scope)` claims into one (count drops); `⊕_synthesize_as` unions evidence and produces a `Claim` with the combined confidence.

## Stack & conventions

TypeScript (ESM/NodeNext, strict), Vitest, Zod, better-sqlite3 — unchanged from MVP. Core `[C]` tier only; `requiredTiers = {core}`. TDD mandatory: each operator/rule gets tests pinned to the spec's worked numeric examples above. Relative imports use explicit `.js` extensions; concurrent implementers commit with pathspec (`git commit -m … -- <files>`).
