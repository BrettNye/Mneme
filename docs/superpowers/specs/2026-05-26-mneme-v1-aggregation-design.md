# Mneme v1 — Aggregation α + Beta-typed Rate (sub-milestone 4)

**Date:** 2026-05-26
**Status:** Approved (brainstorming)
**Canonical spec:** `mneme-spec-v0.2-consolidated.md` — §4.13 (aggregation operators, Beta-typed rate, `α_join_aggregate` + reweight functions), §0.3 (pinned α,β prior), §2.5 (subjective-logic bridge).

## Context

Last of the original four v1 sub-milestones. Combination rules `⊕`, read-time `⊥`/resolve, and derived writes all shipped (green, 485 tests). Aggregation is the most independent slice — no contract changes to shipped files. It introduces a second terminal type `AggregateResult` (alongside `ComposedContext`), the α operators (count / group-by / rate), a **Beta-typed** rate that composes with the distribution machinery, and the `α_join_aggregate` bridge that reweights a `RankedCorpus` by an aggregate (notably Wilson-lower-bound reweighting, which respects sample size).

**Goal:** the concrete §4.13 `[C]` family + the Beta rate + Wilson reweighting. Core `[C]` tier, `requiredTiers = {core}`.

**Builds on** the green v1 tree. Reused (pre-existing): `Corpus`/`RankedCorpus`/`ScoredClaim` (`src/algebra/types.ts`), `Claim` (`src/core/claim.ts`), the pinned prior `DEFAULT_PRIOR` + `Confidence` (`src/core/confidence.ts`), `getPath` for value-path access (`src/algebra/value-predicate.ts`), the `Stage`/`evaluate` model + `EvalContext` (`src/algebra/expression.ts`), the façade builders (`src/mneme.ts`).

## How it fits the Stage/evaluate model

`AggregateResult` is a **second terminal type** alongside `ComposedContext`. The α aggregators are **terminal stages** `Corpus → AggregateResult` (exactly like κ produces `ComposedContext`); `evaluate()` already returns whatever the terminal stage yields, so no evaluator change is needed. `α_join_aggregate` is the bridge: a `RankedCorpus → RankedCorpus` stage that **closes over a precomputed `AggregateResult`** (produced by a separate aggregation query) plus a join key and reweight fn — so the two-input operator fits the unary pipe cleanly.

## Scope

**In scope:**
- Types: `AggregateResult { groups: Map<GroupKey, AggValue> }`; `GroupKey = scalar | tuple | none`; `AggValue = count | sum | avg | min | max | rate(Beta)` (the concrete variants).
- Aggregators: `α_count`, `α_count_where<predicate>`, `α_sum`/`α_avg`/`α_min`/`α_max<value-path>`, `α_groupBy<group-field, aggregator>`, `α_rate<num-predicate, denom-predicate>`, `α_binary_rate<value-path>`.
- Bridge: `α_join_aggregate<join-key, reweight-fn>` + reweight fns `reweight_multiply`, `reweight_multiply_mean`, `reweight_wilson_floor`, `reweight_normalize`, `reweight_boost(factor)`; `wilsonLowerBound(beta)`.

**Deferred (NOT this slice):**
- Extension hooks: `α_custom<fn>`, `AggValue.custom`, `AggValue.distribution(samples)`, `reweight_custom(fn)`.
- Aggregate→corpus conversion (§G) and multi-level `α_groupBy` composition.
- Configurable Wilson confidence level — fixed at 95% (z = 1.96).

## Components

### 1. `src/algebra/aggregation.ts` — types + aggregators + Beta rate

- Types `AggregateResult`, `GroupKey` (scalar/tuple/none), `AggValue` (count/sum/avg/min/max/rate; rate carries `{ alpha: number; beta: number }`).
- A claim-path resolver `claimPath(claim, path)`: `scope.<field>` reads `claim.scope[field]`; `value.<…>` delegates to the existing `getPath(claim.value, rest)`; bare paths read top-level claim fields. Used by `group-field` and `value-path`.
- **Core vs wrapped shape:** each aggregator has a core form `(claims: Claim[]) => AggValue`; the top-level `α_X` operators wrap that core as an `AggregateResult` with a single `GroupKey.none` entry, and `α_groupBy` applies the core form per group. The `aggregator` argument to `α_groupBy` is a core `(Claim[]) => AggValue` (e.g. the core of `binary_rate`).
- Simple aggregators (ungrouped → a single `GroupKey.none` entry): `αCount`, `αCountWhere(predicate)`, `αSum/αAvg/αMin/αMax(valuePath)`.
- `αGroupBy(groupField, aggregator)`: partition claims by `claimPath(claim, groupField)`, run the chosen core aggregator over each group's claims, emit one `AggValue` per group key.
- `αRate(numPredicate, denomPredicate)` and `αBinaryRate(valuePath)`: count `r` = claims matching num, `s` = claims matching (denom ∧ ¬num); emit `AggValue.rate(Beta(α=r+a·W, β=s+(1−a)·W))` using `DEFAULT_PRIOR` (W=2, a=0.5). `binary_rate<path>` = `rate<num: path=true, denom: path=true ∨ path=false>` (excludes null/pending). These are the aggregators most often passed to `αGroupBy`.

### 2. `src/algebra/aggregate-join.ts` — bridge + reweights + Wilson

- `wilsonLowerBound(beta, z = 1.96): number` — recover raw counts from the prior-inclusive Beta (`r = α − a·W`, `s = β − (1−a)·W`, `n = r + s`); for `n ≤ 0` return 0; else the Wilson score-interval lower bound `(p̂ + z²/2n − z·√((p̂(1−p̂) + z²/4n)/n)) / (1 + z²/n)` with `p̂ = r/n`.
- Reweight fns `(score, aggValue, allValues?) → number`: `reweightMultiply` (× a [0,1] value), `reweightMultiplyMean` (× Beta mean), `reweightWilsonFloor` (× `wilsonLowerBound(beta)`), `reweightNormalize` (value / max over all aggregates), `reweightBoost(factor)` (score + value·factor).
- `αJoinAggregate(aggregate, joinKey, reweightFn): (rc: RankedCorpus) => RankedCorpus` — for each `ScoredClaim`, look up the matching `AggValue` in `aggregate.groups` by `claimPath(claim, joinKey)`; apply the reweight fn to adjust the score; re-sort by descending adjusted score. Claims with no matching aggregate keep their original score (documented).

### 3. `src/mneme.ts` façade wiring

Expose `alpha` builders that produce stages: `alpha.count()`, `alpha.countWhere(pred)`, `alpha.sum/avg/min/max(path)`, `alpha.groupBy(field, aggregator)`, `alpha.rate(num, denom)`, `alpha.binaryRate(path)` — terminal `Corpus → AggregateResult` stages; and `alpha.joinAggregate(aggregate, joinKey, reweightFn)` — a `RankedCorpus → RankedCorpus` stage. Expose `reweight.*` fns. Re-export `AggregateResult`/`AggValue`/`GroupKey` types from `src/index.ts`. (`query()` already returns the terminal stage's value, so an aggregation pipeline returns `AggregateResult`.)

## Data flow (worked example, §4.13)

```
outcomes = leaf(c) | σ(subject=action ∧ key=action.outcome)
winBetas: AggregateResult = evaluate( [leaf, σ, alpha.groupBy("scope.actionId", binaryRate("value.won"))], ctx )
ranked   = evaluate( [leaf, σ(actions), rho.jaccard(context)], ctx )            // RankedCorpus
reranked = evaluate( [ ...ranked-pipeline, alpha.joinAggregate(winBetas, "scope.actionId", reweightWilsonFloor) ], ctx )
composed = kappa.xml(12000)(reranked)
```

## Testing (pinned to §4.13)

- Simple aggregators correct over a small corpus; the law `α_count(σ_p(C)) = α_count_where<p>(C)`.
- `α_groupBy<scope.actionId, binary_rate<value.won>>` emits one `Beta` rate per action group; `α_rate` denominator excludes unresolved (only num∨false counted).
- **Beta rate:** 22 won / 8 lost → `Beta(23, 9)` using the pinned prior W=2, a=0.5 (`α = 22 + a·W = 23`, `β = 8 + (1−a)·W = 9`). (For this particular prior the values coincide with Laplace +1/+1; the point is the rate uses the corpus's declared prior, parameterized by `DEFAULT_PRIOR`, not a hardcoded +1/+1.)
- **Wilson (marquee):** `wilsonLowerBound(Beta(23,9)) ≈ 0.555` and `wilsonLowerBound(Beta(2,1)) ≈ 0.207`; `n=0` → 0. End-to-end: `α_join_aggregate(ranked, winBetas, reweight_wilson_floor)` ranks the 22/30 action **above** the 1/1 action, even though 1/1's mean (1.0) exceeds 22/30's (0.73) — sample size respected.
- `reweight_multiply_mean` uses the Beta mean; `reweight_normalize` divides by the max aggregate; a claim with no matching aggregate keeps its original score.

## Stack & conventions

TypeScript (ESM/NodeNext, strict), Vitest, Zod, better-sqlite3 — unchanged. Core `[C]` tier only. TDD mandatory; each operator pinned to the behaviors above. Relative imports use explicit `.js` extensions; concurrent implementers commit with pathspec.
