# Mneme v0.2 expansion plan (revised)

**Status:** Draft expansion proposal. Builds on Mneme v0.1.1 (errata applied).
**Scope:** Tiered capability additions to the Mneme spec.
**Relationship to v0.1.1:** This document references the v0.1.1 errata as its baseline. Math corrections, value predicates, and version-pinning provenance are bug-fixes documented in the errata and are not part of this expansion. v0.2 proposes new capability beyond corrected v0.1.

---

## 0. Motivation and framing

### 0.1 What this expansion does

v0.2 adds three new capabilities to the Mneme algebra, plus an architectural commitment to a tiered structure that distinguishes core algebra from protocol-based extensions from customer-gated profiles.

The three capabilities are:

1. **N-way contradiction clustering** — generalizes pairwise contradiction detection to clusters, with pairs as a derived special case
2. **Aggregation operators** — count, group-by, rate, and the bridge operator that re-enters the algebra after aggregation
3. **Distribution protocol completion** — Dirichlet, Gaussian, and Kalman fusion as reference implementations of the existing DistributionProtocol from v0.1 §4.6

A fourth capability (erasure semantics) is *specified architecturally* but deferred to a customer-gated profile rather than shipped as core. The rationale is in §0.3 below.

### 0.2 Tiered structure

v0.2 introduces a three-tier commitment model:

**Core** — operators and types that all Mneme implementations MUST support. Correctness obligations of the library. Includes the entire v0.1.1 algebra plus the new aggregation operators and n-way clusters added by v0.2.

**Protocol extensions** — capabilities exposed through declared protocols (DistributionProtocol, SimilarityFn, AuthorizationAdapter). Reference implementations are provided but the protocol is the contract. Consumers can supply their own implementations. Dirichlet, Gaussian, and Kalman fusion live here rather than in core, narrowing the core's correctness surface.

**Customer-gated profiles** — capabilities specified architecturally but not shipped until a specific customer requirement justifies the investment. Erasure semantics is the first such profile. Federation, schema migration, and distributed multi-writer semantics are expected future profiles.

This tiering replaces v0.2's earlier "additive expansion" framing, which the v0.1 critique correctly identified as conflating different levels of commitment and inviting kitchen-sink growth.

### 0.3 What's deferred and why

Two things from the earlier v0.2 draft are explicitly held back:

**Erasure as a customer-gated profile, not a v0.2 core addition.** The earlier draft sequenced erasure first as a regulatory unblocker. On reconsideration: no signed regulated customer currently exists, the crypto design needs reconsideration (per the v0.1.1 review, salt is wrong; HMAC with KMS-held key is required), the legal foundation is uncertain (preserving content hashes may itself be GDPR personal data for low-entropy domains), and the engineering cost is 22-25 weeks not 13 once authenticated data structures are properly costed.

This is not capability rejection. It is appropriate sequencing: do not build a 22-week regulatory feature with significant crypto and legal risk for hypothetical customers. When a real regulated customer is in the pipeline, design erasure *with their specific regulatory context and legal counsel*, accept the proper cost estimate, and ship it. The architecture sketch is preserved in §4 for that future work.

**Distribution generalization demoted to protocol implementations.** The earlier draft put Dirichlet, Gaussian, and Kalman in core. On reconsideration: v0.1.1 already pins the Beta + scalar machinery correctly. Dirichlet generalizes the Beta math cleanly via the same subjective-logic bridge. Gaussian + Kalman is *categorically different* math (measurement-uncertainty fusion, not subjective-logic belief combination) and serves a specific vertical (sensor/measurement domains). Putting all of this in core puts the riskiest math in the correctness surface for every implementation, regardless of whether they need it. Moving Dirichlet/Gaussian/Kalman to protocol implementations narrows core, lets vertical-specific implementations come from consumers or community, and preserves correctness boundaries.

### 0.4 What this expansion claims

Honest scope:

v0.2 closes the "outcome-correlated reweighting" gap identified in v0.1.1 — §1.3's promise that "evolution is a query pattern" remains aspirational until aggregation operators exist. This is debt the spec already incurred and v0.2 pays it.

v0.2 closes the n-way contradiction representation gap — a natural completion of an existing operator, low-cost, low-risk.

v0.2 establishes the protocol structure for distribution extensions, so Dirichlet, Gaussian, Kalman, and future distribution types can be added by consumers or community without modifying core.

v0.2 does NOT claim to be a universal AI memory library. It is the typed algebra for enterprise AI orchestration memory with audit-grade provenance. Vertical-specific needs (consumer-scale, regulatory erasure, sensor measurement) are served by appropriate adapter choices, protocol extensions, and customer-gated profiles.

---

## 1. N-way contradiction clustering

### 1.1 The gap

v0.1.1 §4.8 defines `⊥ : Corpus → Set<ContradictionPair>`. When multiple claims disagree about the same (subject, key, scope) with three or more distinct values, the pair representation produces N×(N-1)/2 binary pairs that lose the structure of the disagreement: "three sources support A, one supports B, one supports C" is more informative than "seven pairs in conflict."

### 1.2 The addition

A cluster-typed contradiction representation alongside the existing pair representation:

```
ContradictionCluster {
  triple                   : (Subject, Key, Scope)
  valueGroups              : Map<Value, Set<Claim>>
  totalClaims              : Number
  distinctValues           : Number
  agreementRatio           : Number              -- largest_group_size / total_claims; 1.0 = consensus, 1/k = perfect disagreement among k groups
  highestConfidenceGroup   : Value?              -- value with highest combined confidence
  combinedConfidences      : Map<Value, Confidence>  -- per-value combined confidence
}
```

The cluster captures: which sources support which values, what the combined confidence is per value, and what the highest-confidence position is.

### 1.3 The expanded operators

```
⊥_pairs    : Corpus → Set<ContradictionPair>      -- v0.1.1 form, retained
⊥_clusters : Corpus → Set<ContradictionCluster>   -- new
```

`⊥_pairs` remains the v0.1.1 operator. `⊥_clusters` is the more general form. Pairs are a derived special case: each cluster with exactly two distinct values produces one pair.

For a cluster with k distinct values, the number of derivable pairs is k×(k-1)/2 if all pairs are needed, or k-1 if "consensus vs each minority" is sufficient. Both projections are supported via helper operators.

### 1.4 Resolution operators

v0.1.1 has resolution operators on pairs (`resolve_deprecate_lower`, `resolve_flag_for_review`, `resolve_keep_both`). v0.2 adds cluster-aware variants:

```
resolve_deprecate_minority      : Set<ContradictionCluster> × Corpus → Corpus
resolve_promote_consensus       : Set<ContradictionCluster> × Corpus → Corpus
resolve_synthesize_belief       : Set<ContradictionCluster> × Corpus → Corpus      (core; binary clusters only)
resolve_synthesize_belief_multi : Set<ContradictionCluster> × Corpus → Corpus      (protocol-tier; k>2 clusters)
```

`resolve_promote_consensus` deprecates minority-position claims and promotes the consensus value to validated status.

`resolve_synthesize_belief` (core) produces a new derived claim representing the combined belief over a *binary* disagreement (exactly two value groups). Uses the Beta-typed combined confidence via the corrected SL bridge from v0.1.1 §2.2. Available to all core consumers without protocol-tier dependencies.

`resolve_synthesize_belief_multi` (protocol-tier) handles clusters with k > 2 distinct value groups using the Dirichlet generalization from v0.1.1 §2.3. This depends on the Dirichlet protocol implementation per §3 below. Core-only deployments without the Dirichlet protocol cannot use this operator and must either reduce multi-way clusters to pairwise resolution or pull in the protocol extension.

This split keeps the core-tier promise honest: cluster detection works in core, but multi-way belief synthesis is a protocol-tier capability because it requires Dirichlet math.

### 1.5 Equational laws

- `⊥_pairs(C) ⊆ derived_pairs(⊥_clusters(C))` — pairs are derivable from clusters (actually equality, but ⊆ is the safe lower-bound statement)
- Cluster generation is deterministic given the (subject, key, scope) grouping function
- Selection commutes: `⊥_clusters(σ_p(C))` includes only clusters whose claims are all in σ_p(C)

### 1.6 Incremental evaluation

Streamable. A new claim either:
- Joins an existing cluster (matches existing (subject, key, scope), adds to a valueGroup)
- Starts a new cluster (matches no existing triple)
- Resolves a cluster (if the new claim's value matches an existing group, increases that group's combined confidence; if it deprecates a minority claim, may collapse the cluster to consensus)

The library maintains per-triple cluster state in subscription state, updated incrementally on each write.

### 1.7 Implementation cost

- ~1 week: ContradictionCluster type and `⊥_clusters` operator
- ~1 week: cluster-aware resolution operators
- ~1 week: incremental evaluation and subscription support
- ~1 week: testing and documentation

Total: ~4 person-weeks. Smallest of the v0.2 additions.

---

## 2. Aggregation operators

### 2.1 The gap

v0.1.1 §1.2 lists "outcome-correlated reweighting" as a first-class need. v0.1.1 §1.3 says "evolution is a query pattern." The algebra has no operators that can compute aggregates over claim sets — count, group-by, sum, rate. Outcome-correlated reweighting cannot be expressed.

This is the largest single gap between what the spec promises and what the algebra delivers. v0.2 closes it.

### 2.2 The new return type

The algebra gains a second terminal type alongside Corpus and ComposedContext:

```
AggregateResult {
  groups: Map<GroupKey, AggValue>
}

GroupKey =
  | scalar(value: any)
  | tuple(values: List<any>)
  | none                              -- for ungrouped aggregates

AggValue =
  | count(n: Number)
  | sum(value: Number)
  | avg(value: Number)
  | min(value: any)
  | max(value: any)
  | rate(beta: Beta)                  -- changed from earlier draft: emits Beta, not raw ratio
  | distribution(samples: List<Number>)
  | custom(value: any, fn: AggregateFunction)
```

AggregateResult is a typed structured value that can be consumed by reweighting operators, used directly by application code, or composed with other aggregates.

**Important change from the earlier v0.2 draft.** `rate` previously emitted a raw numerator/denominator ratio. The v0.1.1 review correctly noted that this discards sample-size uncertainty: 22/30 wins and 1/1 wins compute to 0.73 and 1.0 respectively, but the second is overwhelmingly noisier and should not outrank the first. v0.2 fixes this by having `α_rate` emit a Beta distribution, parameterized by the underlying counts. Downstream reweighting can use the Beta's mean, the Wilson lower bound, or any other confidence-aware scoring — composing cleanly with the v0.1.1 distribution machinery.

### 2.3 The aggregation operators

```
α_count : Corpus → AggregateResult
α_count_where<predicate> : Corpus → AggregateResult

α_sum<value-path> : Corpus → AggregateResult
α_avg<value-path> : Corpus → AggregateResult
α_min<value-path> : Corpus → AggregateResult
α_max<value-path> : Corpus → AggregateResult

α_groupBy<group-field, aggregator> : Corpus → AggregateResult

-- Primary rate form: explicit numerator and denominator predicates
α_rate<num-predicate, denom-predicate> : Corpus → AggregateResult

-- Convenience for binary outcome domains
α_binary_rate<value-path> : Corpus → AggregateResult

α_custom<fn> : Corpus → AggregateResult
```

The `<group-field>` parameter is a field path (`scope.actionId`, `scope.entityId`, `value.category`). The `<aggregator>` is one of the simple aggregate operators or a custom function.

`α_rate<num, denom>` takes two predicates explicitly. The numerator counts claims matching `num-predicate`. The denominator counts claims matching `denom-predicate`. This is the primary form because real outcome domains often include unresolved states (`pending`, `null`, `cancelled`) that should not count as failures.

`α_binary_rate<value-path>` is sugar for `α_rate<num: value-path = true, denom: value-path = true ∨ value-path = false>`. It excludes null/pending/unresolved states from both numerator and denominator. Use this when the outcome domain is strictly binary and unresolved values should be ignored.

Both forms emit a Beta distribution parameterized by the corpus's pinned W and base rate from v0.1.1 §1.2. For r positive observations and s negative observations (matching the numerator predicate vs. matching the denominator-but-not-numerator predicate), the emitted Beta is:

```
Beta(α = r + a·W, β = s + (1-a)·W)
```

This composes cleanly with the v0.1.1 SL bridge — the same convention applies. Note this is NOT Laplace smoothing (+1/+1); it uses the corpus's declared prior. Consumers can extract:
- Mean: standard Beta mean for the point estimate
- Wilson lower bound: confidence-aware floor that penalizes small samples
- Full distribution: for downstream uncertainty propagation

### 2.4 The bridge operator

The bridge from AggregateResult back to RankedCorpus:

```
α_join_aggregate<corpus-field, aggregate-key, reweight-fn> :
  RankedCorpus × AggregateResult → RankedCorpus
```

For each claim in the RankedCorpus, look up the matching aggregate value by the join key, apply the reweight function to adjust the claim's score.

Standard reweight functions:

```
reweight_multiply         : score × aggregate_value          -- when aggregate is in [0,1]
reweight_multiply_mean    : score × mean(aggregate_beta)     -- for Beta aggregates
reweight_wilson_floor     : score × wilson_lower_bound(beta) -- confidence-aware
reweight_boost(factor)    : score + (aggregate_value × factor)
reweight_normalize        : aggregate_value / max(all_aggregates)
reweight_custom(fn)       : user-defined
```

The new `reweight_multiply_mean` and `reweight_wilson_floor` functions are specifically for Beta-typed aggregates, addressing the sample-size sensitivity issue.

### 2.5 Worked example: win-rate reweighting (corrected)

The pressure-test query that v0.1 could not express, now expressed correctly:

```
let actions = σ_subject="action" ∧ key="action.recommended" (corpus("sales-app"))
let outcomes = σ_subject="action" ∧ key="action.outcome" (corpus("sales-app"))

-- Compute Beta-typed win-rate per action, excluding pending/null outcomes
let win_betas = α_groupBy<scope.actionId,
                          binary_rate<value.won>>(outcomes)

-- Rank candidate actions by base similarity
let ranked = ρ_cosine, current_context (actions)

-- Reweight by Wilson lower bound, which penalizes small samples
let reranked = α_join_aggregate<scope.actionId,
                                groupKey,
                                reweight_wilson_floor>(ranked, win_betas)

-- Compose final context
let composed = κ_xml, 12000_tokens (reranked)
return composed
```

The action with 22/30 wins (Wilson lower bound ≈ 0.55) now correctly outranks the action with 1/1 win (Wilson lower bound ≈ 0.21 at 95% confidence). Sample size is respected — even though 1/1 has a higher point estimate (1.0 > 0.73), the Wilson lower bound penalizes the small sample, and the well-evidenced 22/30 action wins. The aggregation family composes with the distribution family.

If the outcome domain had three values (`won`, `lost`, `pending`) and we needed to control denominator explicitly:

```
let win_betas = α_groupBy<scope.actionId,
                          rate<num: value.won = true,
                               denom: value.won = true ∨ value.won = false>>(outcomes)
```

This excludes pending outcomes from both numerator and denominator — they don't count as losses but they also don't dilute the rate.

### 2.6 Equational laws

- `α_count(σ_p(C)) = α_count_where<p>(C)` — pre-filtering equals filtered aggregation
- Selection generally commutes through aggregation when the predicate doesn't reference aggregate values

Aggregation operators do NOT have a closed-form composition with each other. The earlier draft's claim about `α_groupBy(α_groupBy(...))` being well-defined was wrong (the type signatures don't match — aggregate results are not corpora). The v0.2 spec drops this claim. Composing aggregations requires either an explicit aggregate-to-corpus conversion (deferred) or expressing the composition as a single multi-level groupBy with appropriate group keys.

### 2.7 Incremental evaluation

Aggregation operators are conditionally streamable:

- `α_count`, `α_sum`, `α_avg`, `α_rate` are streamable — each write contributes to running totals
- `α_min`, `α_max` are streamable for additions, require re-scan for deletions
- `α_groupBy` is streamable when the group-field is stable per claim
- `α_custom` depends on the function — consumers declare streamability via the AggregateFunction protocol

For subscriptions, queries that include aggregation must be over streamable aggregates, or pay re-evaluation cost on each corpus change.

### 2.8 Storage adapter support

Aggregation translates well to SQL adapters (GROUP BY, COUNT, SUM are native operations). Vector DBs typically lack aggregation; the library falls back to retrieving the candidate set and aggregating in memory.

For high-cardinality groupBy operations (e.g., grouping over millions of distinct values), the library should provide cardinality hints to consumers and refuse pathologically expensive queries.

### 2.9 Implementation cost

- ~2 weeks: AggregateResult type and aggregation operator definitions
- ~2 weeks: optimizer integration with push-down to SQL adapters
- ~1 week: bridge operator with Beta-aware reweight functions
- ~1 week: incremental evaluation for streamable aggregates
- ~1 week: SQLite + Postgres adapter implementations
- ~1 week: testing and documentation

Total: ~8 person-weeks.

---

## 3. Distribution protocol completion

### 3.1 The gap and the reframe

v0.1.1 §1 pins the Beta + scalar machinery correctly. The remaining work — supporting Dirichlet (multi-category beliefs), Gaussian (continuous measurements), and Kalman fusion — was originally proposed as core algebra additions.

On reconsideration, this is the wrong tier. Dirichlet, Gaussian, and Kalman fusion are *vertical-specific math*. Consumers in subjective-logic-style decision systems need Dirichlet. Consumers in sensor/measurement domains need Gaussian + Kalman. Consumers in pure orchestration scenarios (the v0.1.1 baseline) need neither.

v0.1 §4.6 already defines a `DistributionProtocol` for custom distributions. v0.2 *fills out the protocol* and provides Dirichlet, Gaussian, and Kalman as *reference implementations*, rather than adding them to core.

This narrows core's correctness surface. Implementations that only need Beta + scalar are not obligated to implement Dirichlet or Gaussian correctness. Implementations that need these can pull in reference implementations or write their own.

### 3.2 The completed protocol

The DistributionProtocol from v0.1 §4.6, completed with the operations needed for combination:

```
DistributionProtocol<T> {
  -- Serialization
  serialize(d: T) → bytes
  deserialize(b: bytes) → T
  canonicalize(d: T) → bytes              -- for hashing in derivation provenance
  
  -- Statistics
  mean(d: T) → Number
  variance(d: T) → Number
  pdf(d: T, x: any) → Number              -- optional, may throw NotImplemented
  
  -- Conversion (for mixed-distribution combination)
  to_subjective_logic_opinion(d: T) → SLOpinion?    -- optional; required for Dempster combination
  from_subjective_logic_opinion(o: SLOpinion) → T?  -- optional
  
  -- Combination rules per protocol implementation
  combine(rule_id: string, a: T, b: T, params: any) → T
  supported_rules() → Set<string>          -- declares which rules this implementation supports
  
  -- Idempotence flags per rule
  is_idempotent(rule_id: string) → Bool
}
```

The library uses the protocol uniformly. Core operators don't know whether they're working with Beta, Dirichlet, Gaussian, or custom — they call protocol operations and the registered implementation handles the type-specific math.

### 3.3 Reference implementation: Dirichlet

Dirichlet generalizes Beta to k categories. The reference implementation provides:

- Standard Dirichlet operations (mean, variance per category, marginalization)
- The corrected SL bridge from v0.1.1 §2.3 (Dirichlet ↔ subjective-logic multinomial opinion)
- Combination rules (using the rule names pinned in errata §11):
  - `rule_weighted_avg` — trust-weighted average of Dirichlet parameter vectors; **idempotent**
  - `rule_evidence_pooled` — sum of parameter vectors with prior-W subtraction to avoid double-counting; **non-idempotent**
  - `rule_max_mean` — argmax over per-category mean (highest point estimate wins; tie-broken by claim ID); **idempotent**
  - `rule_max_concentration` — argmax over total concentration Σαᵢ (most-informed opinion wins); **idempotent**
  - `rule_dempster` — via SL bridge to multinomial mass functions; **non-idempotent**

Note on the rule_max split: v0.1's ambiguous `rule_max_confidence` was deprecated in errata §11 in favor of two clearly differentiated rules. For Dirichlet, `rule_max_mean` selects the input whose most-likely category has the highest mean. `rule_max_concentration` selects the input with the most evidence backing. These answer different questions; consumers must choose explicitly.

References: Jøsang, *Subjective Logic* (Springer, 2016), chapter 6 for the multinomial-opinion treatment.

### 3.4 Reference implementation: Gaussian

Gaussian distributions for continuous measurements. The reference implementation provides:

- Standard Gaussian operations (mean μ, variance σ², 95% confidence interval, PDF)
- Combination rules (with semantics that preserve the protocol-uniform-rule-name contract, using the rule names pinned in errata §11):
  - `rule_kalman` — **precision-weighted Bayesian fusion** of independent measurements of a fixed underlying quantity. Weights = 1/σ² (precision). Result variance σ²_fused = 1/(1/σ₁² + 1/σ₂²), which is strictly smaller than either input variance. **Non-idempotent** — fusing a measurement with itself fabricates independence that doesn't exist and halves the variance.
  - `rule_weighted_avg` — **trust-weighted opinion averaging**. Weights come from the source-trust table in v0.1 §4.9 (manual=1.3, verification=1.2, workflow=1.0, heuristic=0.9, llm=0.7, imported=0.6), NOT from precision. The result is the moment-matched Gaussian of the trust-weighted mixture distribution. **Idempotent** — averaging an opinion with itself preserves the opinion.
  - `rule_max_concentration` — lowest-variance argument wins (highest precision = highest concentration of mass around the mean). **Idempotent.** This is the rule for "select the most-precise opinion."
  - `rule_max_mean` — argmax over μ (highest position wins). **Idempotent.** Rarely the desired semantic for Gaussian inputs — it just picks the rightmost position — but provided for cross-type consistency with the rule contract.
- Does NOT support `rule_dempster` — Dempster's rule is defined on discrete frames, and a Gaussian over continuous values has no natural mass-function representation. Returns NotSupported.
- Does NOT support `rule_evidence_pooled` — pooling assumes additive evidence counts (Beta/Dirichlet semantics), which has no direct Gaussian analog. Returns NotSupported.

**The trust-vs-precision distinction is the load-bearing semantic difference between the two non-trivial rules for Gaussians.** They are NOT aliases. They answer different questions:

- `rule_kalman` answers: "given two independent measurements of the same fixed quantity, what is the Bayesian posterior?" Weights by precision. Reduces variance. Use when sources are equally trusted but you want to reduce uncertainty via independent observations.
- `rule_weighted_avg` answers: "given two opinions about the same proposition with different source trust levels, what is the trust-weighted average opinion?" Weights by source trust. Preserves or increases variance. Use when sources have different trust levels and you want to preserve uncertainty about which is right.

Combining a high-trust imprecise sensor with a low-trust precise one illustrates the difference: `rule_kalman` would weight by precision (low-trust precise wins), `rule_weighted_avg` would weight by trust (high-trust imprecise wins). These produce different means. The choice between them is a domain modeling decision, not a math choice.

**Why the de-aliasing matters for the protocol contract.** The DistributionProtocol exists to provide a uniform rule-name interface across distribution types. If `rule_weighted_avg` collapsed into `rule_kalman` for Gaussians only, a consumer registering a custom distribution type wouldn't know which semantic to implement — trust-weighted averaging (the Beta/Dirichlet contract) or precision-weighted fusion (the Gaussian-aliased version)? Keeping them distinct keeps the contract uniform: `rule_weighted_avg` is always trust-weighted opinion averaging; `rule_kalman` is always precision-weighted Bayesian fusion. Each distribution type implements the semantics correctly for its math, not by aliasing.

The Kalman combination formula:

```
combine_kalman(G₁(μ₁, σ₁²), G₂(μ₂, σ₂²)) = G(μ, σ²)
where:
  σ²  = 1 / (1/σ₁² + 1/σ₂²)
  μ   = σ² × (μ₁/σ₁² + μ₂/σ₂²)
```

The trust-weighted average formula (moment-matched Gaussian of the trust-weighted mixture):

```
combine_weighted_avg(G₁(μ₁, σ₁²), G₂(μ₂, σ₂²), w₁, w₂) = G(μ_avg, σ²_avg)
where:
  w₁, w₂ are normalized source-trust weights from v0.1 §4.9 (w₁ + w₂ = 1)
  μ_avg  = w₁μ₁ + w₂μ₂
  σ²_avg = w₁σ₁² + w₂σ₂² + w₁w₂(μ₁ − μ₂)²
```

The variance formula is the law of total variance: weighted within-component variance plus between-component variance. The cross-term `w₁w₂(μ₁−μ₂)²` captures the uncertainty about which source is correct, which is exactly what opinion-averaging is supposed to represent. The variance never shrinks below the smaller input; it can be larger than both when the means disagree, which is the right behavior.

**Idempotence verification.** With G₁ = G₂ = G(μ, σ²) and any weights w₁ + w₂ = 1: μ_avg = μ; σ²_avg = (w₁+w₂)σ² + w₁w₂·0² = σ². Returns G(μ, σ²) exactly. ✓ Idempotent, consistent with the errata §6.2 table.

**Caveat: moment-matched approximation can misrepresent bimodal shape.** The moment-matched Gaussian is a *unimodal approximation* of what is potentially a bimodal mixture. When two trusted sources strongly disagree (`(μ₁−μ₂)² > σ₁² + σ₂²`, a rough threshold for visible bimodality), `rule_weighted_avg` returns a single Gaussian centered in the empty space between the modes with inflated variance — "probably around the midpoint, uncertain" when the truth is "A or B, not between." This is at odds with v0.2 §1's rationale for preserving disagreement structure via clusters.

When the between-means term `w₁w₂(μ₁−μ₂)²` dominates the within-variance terms `w₁σ₁² + w₂σ₂²`, the moment-matched Gaussian misrepresents the shape of the underlying mixture. Consumers should consider cluster-style representation (per §1) instead of averaging, or fuse via `rule_kalman` if the sources are genuinely independent measurements of the same quantity. The library can detect this condition at runtime and warn; the v0.2 reference implementation emits a `bimodal_approximation_warning` when the between-means term exceeds the within-variance terms by 2x or more.

**Connection to errata §6.2.** The de-aliasing keeps the rule-level idempotence claims in v0.1.1 §6.2 valid across all distribution types. `rule_weighted_avg` is idempotent for Beta, Dirichlet, scalar, AND Gaussian inputs. The earlier "Gaussian weighted_avg is non-idempotent because it's a kalman alias" claim was a regression that contradicted the errata table; this de-aliasing removes the contradiction.

The reference implementation flags non-idempotence of `rule_kalman` loudly in its documentation. **Consumers using `rule_kalman` MUST implement observation-level deduplication** — re-ingesting the same measurement with the same observation ID must be filtered before fusion. The library provides an `observation_id` field on claims to support this; the protocol's `is_idempotent(rule_id)` returns false for `rule_kalman` so callers know to deduplicate.

References: Welch & Bishop, "An Introduction to the Kalman Filter" (UNC, 1995, periodically updated). For the moment-matching of mixtures, any standard text on mixture distributions or Bayesian model averaging.

### 3.5 Mixed-distribution combination

When a combination operation receives inputs of different distribution types, the library:

1. Checks if either type has a registered conversion to the other (via DistributionProtocol's `to_subjective_logic_opinion` or explicit consumer-registered converters)
2. Applies the conversion if available
3. Performs combination in the unified type
4. Returns the result in the unified type

Standard conversions in the reference implementations:

- **scalar → Beta**: per v0.1.1 §7, requires explicit pseudocount; no silent default
- **Beta → Dirichlet (same frame)**: A Beta(α, β) over {True, False} maps directly to a 2-category Dirichlet(α, β). Same frame, no semantic shift.
- **Beta → SL opinion**: via the corrected bridge from v0.1.1 §2.2
- **Dirichlet → SL opinion**: via the generalized bridge from v0.1.1 §2.3

**Frame extension is NOT a standard conversion.** A Beta-typed claim about "is at Port A" has frame {True, False}. A Dirichlet-typed claim about "vessel location" has frame {Port A, Port B, Port C}. These are *different propositions* and the library cannot silently convert between them — a Beta about a singleton is not equivalent to a Dirichlet over the full frame.

When combining claims that nominally describe the same fact but use different frames, the consumer must perform explicit frame extension before combination. The library provides:

```
extend_to_frame(beta: Beta, target_frame: Frame, mapping: BetaToFrameMapping) → Dirichlet

BetaToFrameMapping {
  trueMapsTo  : SingletonId          -- which singleton in the target frame corresponds to "True"
  -- "False" mass is split among remaining singletons proportionally
  -- to the target frame's declared base rates
}
```

**Semantic: strip the Beta's prior, redistribute raw evidence under the target frame's prior structure.** This ensures the resulting Dirichlet has internally consistent priors regardless of whether the Beta's base rate matched the target's.

For input Beta(α, β) with binary prior (W_binary, a_binary) and target frame {A, B, C} with base rates (a_A, a_B, a_C) and prior weight W_target, with `trueMapsTo = A`:

```
-- Step 1: Strip the Beta's prior to recover raw evidence counts
r = α − a_binary · W_binary             -- raw positive evidence
s = β − (1 − a_binary) · W_binary       -- raw negative evidence

-- Step 2: Distribute raw counts under the target frame's prior structure
α_A = r + a_A · W_target                -- True evidence goes to A, with A's prior
α_B = s · (a_B / (1 − a_A)) + a_B · W_target    -- False evidence proportional to base rate, with B's prior
α_C = s · (a_C / (1 − a_A)) + a_C · W_target    -- False evidence proportional to base rate, with C's prior
```

The output is Dirichlet(α_A, α_B, α_C), with uniform W_target across all categories and prior structure matching the target frame's declared base rates.

**Worked example.** Beta(3, 2) with W_binary=2, a_binary=0.5 (so r=2, s=1). Target frame {A, B, C} with a_A=0.5, a_B=0.3, a_C=0.2, W_target=2. trueMapsTo=A.

- α_A = 2 + 0.5·2 = 3
- α_B = 1 · (0.3 / 0.5) + 0.3·2 = 0.6 + 0.6 = 1.2
- α_C = 1 · (0.2 / 0.5) + 0.2·2 = 0.4 + 0.4 = 0.8

Result: Dirichlet(3, 1.2, 0.8). Total concentration = 5. In this example, the input Beta has α+β = 5 and W_binary = 2 = W_target, so the concentrations match — but this equality is a property of the example's matched W's, not a general guarantee (see Properties below). Sum of priors = a_A·W + a_B·W + a_C·W = 2 (matches W_target). ✓ Prior structure is internally consistent.

**Properties of this construction:**
- *Raw-evidence preserving*: r + s is preserved exactly across the operation. The evidence count from the input survives intact in the output's category totals (after subtracting target priors).
- *Total concentration* Σαᵢ = r + s + W_target. This equals the input's α + β only when W_target = W_binary. The worked example happens to satisfy this (both W's are 2), which makes the totals match; in the general case the totals differ by (W_target − W_binary).
- *Prior-consistent*: the resulting Dirichlet's prior structure has uniform weight W_target across all categories, matching the target frame's declared base rates.
- *Convention-clean*: when stripped to raw counts (the (r, s) → (r_A, r_B, r_C) view), the operation is just "True-evidence goes to A; False-evidence splits between B and C proportionally to base rates."
- *Round-trip*: marginalizing the result back to a 2-category {A, ¬A} Dirichlet recovers Beta(α_A, α_B + α_C) = Beta(r + a_A·W_target, s + (1−a_A)·W_target). This equals the input Beta when (a_binary, W_binary) = (a_A, W_target); otherwise it recovers the input's raw evidence (r, s) paired with the target frame's prior structure — which is the operation's intended renormalization, not a defect.

**Caveat: this is a maximum-entropy approximation, not a lossless conversion.** The original Beta knew "False" was about a singleton outside {A}; the extended Dirichlet now treats the False evidence as informative about B vs. C in proportion to base rates. This introduces information that wasn't in the original Beta. The base-rate split is the maximum-entropy choice given no further information, but it is an approximation.

Consumers who need to preserve "the original source had no opinion about B vs. C" must register a custom converter using a Jøsang hyper-opinion representation (mass on the composite focal element {B, C} rather than split between singletons). Hyper-opinions require extending the DistributionProtocol to support powerset-indexed mass functions, which is outside v0.2 scope. The base-rate split is the v0.2 default; finer control is via custom converter.

No standard conversion exists for Gaussian ↔ Beta or Gaussian ↔ Dirichlet. Combination across these types returns NotSupported. Consumers needing such combinations register custom converters via the DistributionProtocol.

### 3.6 Implementation cost

The protocol completion itself is small. Reference implementations are the work:

- ~1 week: complete the DistributionProtocol interface
- ~1 week: Dirichlet reference implementation (including SL bridge per v0.1.1)
- ~2 weeks: Gaussian reference implementation with Kalman fusion
- ~1 week: mixed-distribution conversion machinery
- ~1 week: testing (carefully — this is where silent semantic errors hide)

Total: ~6 person-weeks for the protocol completion and reference implementations.

**Important:** if a consumer only needs Beta + scalar (the common orchestration case), they pay zero of this cost. The reference implementations are opt-in. This is the value of moving the work to protocol tier — vertical-specific math doesn't burden general consumers.

---

## 4. Erasure semantics (deferred to customer-gated profile)

### 4.1 Why this is here but deferred

Erasure was the centerpiece of the earlier v0.2 draft. The v0.1.1 review surfaced three serious issues:

1. **Crypto error.** Per-corpus salt is insufficient for low-entropy content domains. HMAC with KMS-held secret keys is required. The earlier draft cost estimate (~1 week for crypto primitives) was off by 3-4x.

2. **Legal hole.** Under GDPR, a hash of personal data may itself be personal data when re-identification is feasible. For low-entropy data (the data that typically triggers erasure requests), preserving content hashes may not satisfy Article 17. The "integrity_verifiable" reproducibility tier may collapse to "unverifiable" for exactly the data that needs erasure. Legal counsel is required to determine the right policy per jurisdiction.

3. **Cost underestimate.** Authenticated data structures (Merkle accumulators over a bitemporal multi-backend corpus) are weeks of work, not "1 week of crypto primitives." Total erasure cost is realistically 22-25 person-weeks, not 13.

Combined with the absence of a signed regulated customer in the immediate pipeline, the appropriate response is to *defer the implementation* while *preserving the architectural sketch* for when a customer requirement crystallizes.

### 4.2 The architectural sketch (preserved)

The earlier v0.2 draft contained a substantive design for erasure: tombstones with preserved cryptographic commitments, stratified reproducibility tiers, derivation provenance with input hashing, the `verify_chain` audit operation. The design is sound at the architectural level. The implementation has issues that require customer-specific resolution.

The sketch is preserved as a customer-gated profile specification. Key design points:

- Erasure is physical removal from primary storage, producing a Tombstone record
- Tombstones preserve metadata (id, schemaVersion, scopeHash, erasure timestamp/reason) but not content
- Content hashes MAY be preserved under HMAC with KMS-held keys, IF legally permissible for the data category
- Derivation provenance includes input hashes (THIS IS ALREADY MANDATORY per v0.1.1 §5 — banked discipline)
- Replay degrades gracefully: exact reproduction when inputs present, integrity-verifiable when inputs erased but hashes preserved, acknowledgment-only when hashes also erased

### 4.3 What's already in place via v0.1.1

The v0.1.1 errata bank the prerequisite for future erasure work:

- Mandatory input hashing in derivation provenance (§5 of errata): future erasures preserve audit chains for derivations committed under v0.1.1, even though current consumers don't need the data
- Embedding-model and similarity-function version pinning (§5 of errata): replay can identify whether necessary models are still available
- Evaluation-clock pinning (§5 of errata): replay is deterministic, no "decay drift"

These are recorded *now*, even without the broader erasure machinery, because they cannot be retroactively added.

### 4.4 When this gets built

When at least one of the following is true:

1. A regulated customer (GDPR-subject, CCPA-subject, HIPAA-subject) is in the signed/imminent pipeline
2. Legal counsel has provided jurisdiction-specific guidance on hash-preservation policies
3. Sufficient engineering capacity is committed for the realistic 22-25 person-week scope

Until then: the architectural sketch is preserved, the prerequisite provenance discipline is in place, and the absence of erasure is documented as a profile gap rather than a system gap.

### 4.5 Customer engagement when this triggers

When a regulated customer enters the pipeline, the work sequence is:

1. Legal review with customer's counsel on hash-preservation policy per their regulatory regime
2. Crypto design pass with the customer's HMAC/KMS infrastructure or our reference KMS
3. Authenticated data structure design with proper cost estimate
4. Implementation per the architectural sketch, adjusted for legal findings
5. Customer-specific compliance documentation

This is a 5-7 month process, not a 3-month one. Customers should be told this honestly.

---

## 5. Other architectural changes

### 5.1 Catalog model: tier metadata

Corpora declare their capability requirements via a `requiredTiers` field:

```
Corpus {
  ...
  requiredTiers: Set<TierRequirement>
}

TierRequirement =
  | core                     -- only core operators needed
  | protocol(name: string)   -- specific protocol extension needed (e.g., "dirichlet", "gaussian")
  | profile(name: string)    -- customer-gated profile needed (e.g., "erasure")
```

A Mneme deployment validates at startup that all required tiers for its hosted corpora are available. Queries that reference operators not available in the deployment's tier set fail at parse time with a clear error.

This makes the tiering structurally enforced rather than merely documented.

### 5.2 Documentation discipline: prior-findings audit

The v0.1.1 errata included a Dempster-associativity error that was carried forward from a prior review without resolution. To prevent recurrence, every spec revision (v0.2, v0.3, future patches) MUST include a "Prior findings reconciliation" section confirming that each finding from prior reviews is either fixed in this revision or deliberately deferred with rationale.

This is process discipline, not algebra. But it is load-bearing for the spec's credibility: a spec that doesn't reconcile its own review history cannot claim to be auditable.

### 5.3 §6.6 reproducibility framing

v0.1.1 §5 corrected the reproducibility guarantee to be conditional on version availability. v0.2 reinforces this: the spec does NOT claim universal reproducibility. It claims version-conditional reproducibility with explicit replay-status semantics. Marketing materials and product documentation should reflect this corrected language.

---

## 6. Summary

### 6.1 What v0.2 adds

| Capability | Tier | Effort | Risk |
|---|---|---|---|
| N-way contradiction clusters | Core | ~4 weeks | Low |
| Aggregation operators | Core | ~8 weeks | Medium |
| Distribution protocol completion + Dirichlet/Gaussian ref impls | Protocol extensions | ~6 weeks | Medium (math correctness) |
| Erasure semantics | Customer-gated profile | Deferred (22-25 weeks when triggered) | High |

Near-term v0.2 scope (core + protocol extensions, erasure deferred): ~18 person-weeks.

**Parallelism with erasure deferred:** the three near-term additions are *mostly* independent, with one soft edge. N-way cluster detection (§1) and aggregation (§2) are fully independent of each other and of the distribution protocol (§3). But `resolve_synthesize_belief_multi` (§1.4), the multinomial form of cluster belief synthesis, depends on the Dirichlet bridge in §3. The binary form (`resolve_synthesize_belief`) is core-only and free of dependencies.

This means parallelism realistically looks like:
- 3 engineers, parallel: ~9-10 calendar weeks for ~18 person-weeks of work. The §1↔§3 soft edge means `resolve_synthesize_belief_multi` lands slightly after the Dirichlet protocol implementation, but doesn't gate the rest of §1.
- 2 engineers: ~10-12 calendar weeks
- 1 engineer sequentially: ~4-5 calendar months

When erasure activates as a customer-gated profile, it does not parallelize well — the crypto, legal, authenticated-data-structure, and replay-degradation work are deeply sequential. Plan single-engineer or two-engineer-with-one-on-testing model for that profile when it triggers.

### 6.2 What v0.2 explicitly does not do

- Federation across Mneme instances (deferred to v0.3)
- Schema migration tooling (deferred to v0.3)
- Cost models and optimizer internals (deferred to v0.3)
- Distributed multi-writer semantics (deferred to v0.3)
- Library-itself observability (deferred to v0.3)
- Erasure (deferred to customer-gated profile)
- Consumer-scale operational specifics (latency budgets, write-throughput targets) (acknowledged as out of v0.2 scope)

### 6.3 Backward compatibility

v0.2 is additive to v0.1.1. All v0.1.1 expressions remain valid. v0.2 operators are new capability.

The aggregation family introduces a new terminal type (AggregateResult) that requires consumer-side handling. Existing v0.1.1 consumers that don't use aggregation are unaffected.

The protocol extensions are opt-in. Consumers that only need Beta + scalar continue to work with no changes.

### 6.4 Acceptance criteria

v0.2 is "complete" when:

1. Aggregation operators are implemented in the reference SQLite and Postgres adapters with native push-down where supported
2. N-way contradiction clustering is implemented with incremental evaluation
3. The DistributionProtocol is finalized with all required operations
4. Dirichlet and Gaussian reference implementations are provided and tested against published reference cases
5. The Polis / Agora integration demonstrates outcome-correlated reweighting (the headline use case for aggregation) end-to-end
6. Documentation clearly distinguishes core, protocol-extension, and customer-gated-profile capabilities

v0.2 acceptance assumes v0.1.1 is in place — v0.1.1 errata application is a separate release gate documented in the errata itself, not a v0.2 criterion. Conflating the two release tracks defeats the purpose of separating them.

### 6.5 Risk register

Items to watch during implementation:

- **Aggregation optimizer work** is real engineering that the cost estimate may underestimate. Hot-aggregate caching, incremental maintenance, and pushdown to SQL adapters all add up. Watch for slippage.
- **Distribution math correctness**: the v0.1.1 errata corrected the Beta + SL bridge and added the convention-propagation check (§12 of errata). The Dirichlet generalization should be straightforward but should be reviewed against published reference cases (Jøsang's examples) before shipping. Frame-extension cases (§3.5) are where consumers will trip — test the mass-preservation and prior-consistency properties explicitly.
- **Backward compatibility of derivation provenance**: v0.1-era derivations lack input hashes and version pinning. v0.2 must handle these gracefully when they appear, marking them as `replay_status: integrity_unknown` (per v0.1.1 errata §5.3 enum) rather than failing.
- **W-scaling for large Dirichlet frames**: the v0.1.1 default of W=2 gives weak prior weight per category when frame size grows. Consumers using large frames should be reminded to consider per-corpus W overrides (per v0.1.1 §2.3 note).
- **Idempotence discipline**: `rule_weighted_avg`, `rule_max_mean`, and `rule_max_concentration` are idempotent across ALL distribution types — including Gaussian. The evidence-combining rules — `rule_evidence_pooled`, `rule_dempster`, `rule_kalman` — are NOT idempotent. The reference implementations expose `is_idempotent(rule_id)` on each DistributionProtocol; consumers must consult this to know whether to deduplicate observations before combination. The v0.1.1 errata §6.2 idempotence table applies uniformly across all distribution types.
- **Protocol-uniform-rule-name contract is load-bearing.** A future contributor adding a new distribution type must implement each named rule with the *semantic* the rule name commits to, not whatever happens to be mathematically convenient for that type. The Gaussian de-aliasing of `rule_weighted_avg` (genuine trust-weighted averaging, idempotent) and `rule_kalman` (precision-weighted Bayesian fusion, non-idempotent) in v0.2 §3.4, and the v0.1.1 §11 split of `rule_max_confidence` into `rule_max_mean` and `rule_max_concentration`, are the canonical examples. When the math superficially collapses or the name is ambiguous, do not alias or default — split into rules with clear semantics. The naming discipline IS the protocol contract.
- **rule_max migration is breaking.** Consumers using v0.1's `rule_max_confidence` will hit a typed error and must explicitly choose `rule_max_mean` (point-estimate selection) or `rule_max_concentration` (evidence-weight selection). The library MUST surface the choice clearly with examples; silent defaulting is forbidden. Document this prominently in upgrade guides.
- **Convention-propagation discipline:** future revisions that pin or correct a foundational convention MUST include a propagation check (per v0.1.1 errata §12) listing every operation that depends on the changed quantity. Audit-by-name finds named operators; only re-derivation by operation finds the unaudited ones. The v0.1.1 §10 `rule_evidence_pooled` correction is the canonical example of a bug that audit-by-name missed.

---

## 7. Prior findings reconciliation

This section confirms reconciliation of findings from prior spec reviews, per the documentation discipline established in §5.2.

### From the v0.1 audit (six pressure-test scenarios):

| Finding | Status in v0.2 |
|---|---|
| Aggregation missing entirely | Addressed in §2 |
| Value predicates missing | Addressed in v0.1.1 errata §4 |
| Distribution model rigidity | Addressed via protocol extensions in §3 |
| Physical erasure unsupported | Deferred to customer-gated profile per §4 with explicit rationale |
| Pair-only contradictions | Addressed in §1 |
| Provenance fields dead weight outside orchestration | Acknowledged; v0.2 does not make this worse; addresses it via the tiering structure that lets consumers ignore unused fields |

### From the v0.2 first audit (earlier draft):

| Finding | Status in v0.2 (revised) |
|---|---|
| A — SL bridge math wrong | Fixed in v0.1.1 errata §2 |
| B — Dempster associativity claim wrong | Fixed in v0.1.1 errata §3 |
| C — α_rate ignores sample size | Fixed in v0.2 §2.2 — α_rate emits Beta, not raw ratio |
| D — GroupBy associativity contradicts type signatures | Removed in v0.2 §2.6 — claim deleted, not defended |
| E — Kalman non-idempotence unflagged | Fixed in v0.1.1 errata §6 |
| F — scalar→Beta upcasting underspecified | Fixed in v0.1.1 errata §7 |
| G — Salt vs. HMAC error | Acknowledged in v0.2 §4.1; full crypto redesign deferred with erasure |
| H — Legal hole on hash preservation | Acknowledged in v0.2 §4.1; legal review required before erasure ships |
| I — Authenticated data structure under-costed | Acknowledged in v0.2 §4.1; cost re-estimated |
| J — Decay drift contradicts determinism | Fixed in v0.1.1 errata §5 — evaluationClock pinned |
| K — Strategic scope creep | Addressed via tiering in §0.2 — capabilities at appropriate commitment levels |
| L — Sequencing optimizes for hypothetical customer | Addressed via §4 deferral — erasure waits for real customer |
| M — Cost estimates omit expensive bits | Re-estimated with realistic numbers in §4 and §1.7/2.9/3.6 |
| N — Value predicates degrade on critical backends | Acknowledged in v0.1.1 errata §4.4 with per-(adapter, predicate-kind) capability matrix |

### From the v0.2 second audit:

| Finding | Status in v0.2 (current) |
|---|---|
| 1 — `rule_weighted_avg` mismarked non-idempotent | Fixed in v0.1.1 errata §6.2 — properties table corrected; idempotence restored to averaging and max-selection rules |
| 2 — ReplayStatus enum drift between errata and v0.2 | Fixed in v0.1.1 errata §5.3 — `integrity_unknown` added as distinct state; v0.2 references match |
| 3 — α,β migration semantic shift unflagged | Fixed in v0.1.1 errata §1.3 — behavioral consequences and three migration options documented |
| 4 — Wilson lower bound arithmetic wrong (0.025 → 0.21) | Fixed in v0.2 §2.5 — number corrected |
| 5 — α_rate signature/usage mismatch | Fixed in v0.2 §2.3 — added `α_binary_rate` convenience form; primary `α_rate` retains explicit two-argument signature; worked example matches |
| 6 — `native_indexed` overstates regex on Postgres | Fixed in v0.1.1 errata §4.4 — per-(adapter, predicate-kind) capability matrix replaces adapter-level summary |

### From the v0.2 third audit:

| Finding | Status in v0.2 (current) |
|---|---|
| W=2 default not addressed for large Dirichlet frames | Fixed in v0.1.1 errata §2.3 — note added about scaling considerations for k > 2 |
| α_rate Laplace smoothing vs. corpus-W convention conflict | Fixed in v0.2 §2.3 — α_rate uses corpus's pinned W and base rate, not Laplace |
| Gaussian `rule_weighted_avg` vs. `rule_kalman` indistinguishable | Initially "fixed" by aliasing — but the aliasing was itself wrong (broke trust-vs-precision contract and §6.2 idempotence table); properly fixed in fourth audit, see below |
| Gaussian `rule_max_confidence` mislabeled non-idempotent | Fixed in v0.2 §3.4 — listed as idempotent; only evidence-combining rules are non-idempotent |
| Beta→Dirichlet "trivial" claim glosses over frame extension | Fixed in v0.2 §3.5 — same-frame conversion remains trivial; cross-frame requires explicit `extend_to_frame` operator |
| §6.1 parallelism estimate stale with erasure deferred | Fixed in v0.2 §6.1 — re-estimated with erasure deferral assumption (further refined in fourth audit, see below) |
| §6.4 acceptance criterion 5 circular (v0.1.1 obligations in v0.2 criteria) | Fixed in v0.2 §6.4 — separated v0.1.1 release gate from v0.2 acceptance |

### From the v0.2 fourth audit:

| Finding | Status in v0.2 (current) |
|---|---|
| Gaussian `rule_weighted_avg` ≡ `rule_kalman` aliasing breaks idempotence table and trust-vs-precision contract | Fixed in v0.2 §3.4 — de-aliased. `rule_weighted_avg` is trust-weighted opinion averaging (idempotent, spread-preserving via moment-matched mixture); `rule_kalman` is precision-weighted Bayesian fusion (non-idempotent, variance-reducing). Errata §6.2 table now uniformly true across all distribution types |
| `extend_to_frame` mapping underspecified (composite-set mass not representable in plain Dirichlet) | Fixed in v0.2 §3.5 — base-rate-split semantic defined explicitly with worked formula; further refined in fifth audit (see below) |
| `agreementRatio` formula undefined | Fixed in v0.2 §1.2 — defined as largest_group_size / total_claims |
| §1↔§3 parallelism overstated (multinomial cluster resolution depends on Dirichlet bridge) | Fixed in v0.2 §1.4 and §6.1 — `resolve_synthesize_belief` (binary, core) split from `resolve_synthesize_belief_multi` (k>2, protocol-tier). Parallelism estimate updated to reflect the soft edge |
| `rule_max_confidence` semantic ambiguity for multi-category distributions | Initially "fixed" in v0.2 §3.3 by quietly committing Dirichlet to concentration — but the fix was incomplete (Beta unpinned, name still misleading); properly fixed in fifth audit by splitting the rule, see below |

### From the v0.2 fifth audit:

| Finding | Status in v0.1.1 / v0.2 (current) |
|---|---|
| `rule_evidence_pooled` for Beta double-counts the prior under pinned convention | Fixed in v0.1.1 errata §10 — convention-propagation correction. Formula now uses `α_pooled = α₁ + α₂ − a·W`, matching the Dirichlet implementation. N-input generalization documented. |
| `rule_max_confidence` ambiguity (mean vs. concentration) — partial third-audit fix was incomplete | Fixed in v0.1.1 errata §11 — split into `rule_max_mean` and `rule_max_concentration`. Ambiguous original name deprecated with breaking-change migration. |
| Moment-matched Gaussian mismodels bimodal posterior | Fixed in v0.2 §3.4 — caveat added explaining when the approximation breaks down; library emits `bimodal_approximation_warning` when between-means term dominates within-variance terms |
| `extend_to_frame` base-rate consistency: α_A = α carries Beta prior into target frame without renormalization | Fixed in v0.2 §3.5 — operation now strips Beta prior, redistributes raw evidence under target frame's prior structure; mass-preserving and prior-consistent |
| Convention propagation not systematic (audit-by-name missed `rule_evidence_pooled`) | Fixed in v0.1.1 errata §12 — process discipline established: convention changes require explicit re-derivation table for every dependent operation |

### From the v0.2 sixth audit:

| Finding | Status in v0.1.1 / v0.2 (current) |
|---|---|
| §12.2 table contained false justification ("prior cancels in ratio" for the mean row) | Fixed in v0.1.1 errata §12.2 — mean row now correctly states that α/(α+β) is convention-dependent in value, per the §1.3 migration shift. Discovery of the false justification motivated tightening every table entry to include explicit derivation rather than hand-waved assertion. |
| §12.2 row for `rule_max_mean` over-claimed convention-neutrality (ordering can flip under different conventions) | Fixed in v0.1.1 errata §12.2 — row now shows the counter-example (Beta(8,0) vs Beta(2,0) tie under raw counts, first wins under prior-inclusive) and clarifies that `rule_max_mean` is convention-fixed within an implementation but not cross-convention neutral. |
| §3.5 "mass-preserving: Σαᵢ = α+β" overclaimed (true only when W_target = W_binary) | Fixed in v0.2 §3.5 — properties bullet rewritten. "Raw-evidence preserving" (r+s invariant) is unconditional; "total concentration" equality is conditional on W_target = W_binary. Worked-example annotation updated to flag this. |
| Process: table entries themselves are claims requiring verification, not assertion | Fixed in v0.1.1 errata §12.4 — discipline extended: every entry in propagation tables MUST include the derivation, not just the conclusion. Applied retroactively to §12.2 — all rows now show derivations. |

All material findings from all six audit rounds are either fixed in v0.1.1, addressed in v0.2, or explicitly deferred with rationale. No finding has been carried forward without reconciliation.

**Process notes accumulated across audit rounds.**

*Third-audit Gaussian fix (initial round):* the third audit flagged that `rule_weighted_avg` and `rule_kalman` looked indistinguishable for Gaussian inputs. The initial response aliased them, which collapsed semantic distinctions and contradicted the errata §6.2 idempotence table that v0.1.1 had just fixed. The fourth audit caught the regression and the correction de-aliased the rules. *Lesson: not every "fix" is in the right direction — re-derivation against source math, not label-matching against audit-finding names, is what catches wrong-direction resolutions.*

*Fifth-audit convention propagation:* the fifth audit found that `rule_evidence_pooled` for Beta double-counts the prior under the convention pinned in v0.1.1 §1. This is the original convention bug surviving in an operator the audit hadn't named. *Lesson: convention changes are graph-level; audit findings are node-level. Reconciling audit findings by operator name catches the audited operator; it does not catch operators that depend on the same convention but weren't individually flagged. v0.1.1 §12 establishes the convention-propagation check as process discipline going forward — when a convention is pinned or corrected, every operation that touches the changed quantity must be re-derived, not just the operators the audit named.*

*Fifth-audit `rule_max_confidence` resolution:* the fifth audit also surfaced that the third-audit "fix" for `rule_max_confidence` quietly committed Dirichlet to concentration semantics while leaving the rule name suggesting mean and the Beta criterion unpinned. The fifth-audit fix splits the rule per the same logic that drove the fourth-audit Gaussian de-aliasing: when two operations have different semantics, give them different names. *Lesson: the protocol-uniform-rule-name contract isn't just about cross-type uniformity — it's also about unambiguous naming within a single type. Ambiguous names invite the same audit finding in every future review.*

---

## End of v0.2 expansion plan (revised)

This plan adopts the tiering structure proposed in the v0.1.1 review: core algebra additions (n-way clusters, aggregation) accompany a protocol-extension completion (distributions) and an explicitly deferred customer-gated profile (erasure). The total near-term scope is ~18 person-weeks of new capability work on top of the ~3-4 weeks of v0.1.1 errata fixes — a 4-5 month release with low legal risk, low crypto risk, and significant toolchain de-risking.

When a regulated customer enters the pipeline, the erasure profile is the next investment, with appropriate legal and crypto preparation. Until then, v0.2's near-term scope addresses the gaps that affect every enterprise customer without front-loading risk for customers who don't yet exist.
