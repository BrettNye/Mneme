# Mneme v0.1.1 errata

**Status:** Errata to v0.1. Corrections to already-published claims.
**Applies to:** Implementations targeting v0.1 of the Mneme specification.
**Scope:** This document corrects errors in v0.1. It is not an expansion. The corrections hold regardless of whether any v0.2 capability additions ship.

---

## 0. About this document

### 0.1 Why errata, not a revision

v0.1 contained mathematical and design errors discovered through adversarial review. These errors affect implementation correctness regardless of which v0.2 capabilities are eventually adopted. Folding the corrections into a v0.2 capability-expansion document would make adopting bug fixes contingent on adopting new scope, which is the wrong shape.

The errata exists as a standalone document that any v0.1 implementer must apply. v0.2 capability additions are a separate proposal that references this errata.

### 0.2 Scope of corrections

The following classes of issue are addressed:

1. **Mathematical errors** — formulas that were wrong as published
2. **Convention ambiguities** — places where v0.1 did not pin a convention, allowing implementations to drift
3. **Missing language** — predicate forms that v0.1 implicitly assumed but did not formally specify (notably value predicates against the `value` field)
4. **Unflagged failure modes** — operators whose risks were not surfaced in v0.1
5. **Process gaps** — provenance fields whose absence makes prior reproducibility claims undeliverable

### 0.3 Backward compatibility

These corrections are *bug fixes*, not capability changes. Implementations that adopted v0.1 as written may produce semantically incorrect results in the affected areas. Specifically:

- Subjective-logic bridge results computed under v0.1's formulas are wrong and should be recomputed under the corrected formulas
- Combination operations marked "associative" that aren't, and vice versa, may have produced incorrect optimizer rewrites
- Derivation provenance written without input hashes or embedding-model versions cannot retroactively gain those fields — v0.1-era derivations remain limited

Consumers should treat v0.1-era derived claims and combinations as suspect until re-validated under v0.1.1 semantics.

---

## 1. Pin the α, β convention (§2.4)

### 1.1 The error

v0.1 §2.4 introduced a `Confidence` type with a Beta distribution parameterized by α and β, and defined effective confidence as α/(α+β) (the Beta mean). v0.1 §4.4 introduced a subjective-logic bridge with formulas referencing α, β, and a non-informative weight W.

The two sections silently assumed opposite conventions for α, β. Without a pinned convention, implementations cannot be consistent, and the formulas in §4.4 are wrong under either reasonable reading.

### 1.2 The correction

**v0.1.1 fixes the convention to the standard subjective-logic relation:**

Given evidence counts (r, s) representing positive and negative observations, with non-informative prior weight W and base rate a:

```
α = r + a·W
β = s + (1 − a)·W
```

That is: α and β include the prior. A claim with no evidence has α = a·W, β = (1−a)·W. For a symmetric prior (a = 0.5) with W = 2, this is Beta(1, 1) — the standard uninformative prior.

Recommended defaults:
- W = 2 (non-informative prior weight)
- a = 0.5 (symmetric base rate) unless the corpus declares otherwise

Corpora may override W and a via the corpus schema; the values used must be recorded in the corpus catalog and propagated to combination operations.

### 1.3 Implementation note

Implementations of v0.1 that interpreted α, β as raw evidence counts (without prior) are incompatible with the corrected §4.4 bridge. Such implementations should:

1. Add prior weights to existing stored α, β values before applying any v0.1.1 operation
2. Update the schema-version tag on affected claims to indicate the migration

Implementations that interpreted α, β as including the prior (the convention v0.1.1 adopts) are correct and require no claim-data migration.

**Migration is not semantically neutral — flag this to downstream consumers.** Adding prior weights to existing claims is a one-time Bayesian shrinkage. Every migrated claim's effective confidence shifts toward the base rate, with the magnitude of the shift inversely proportional to evidence weight.

Worked example: a claim stored as raw (8.2, 1.4) had mean 8.2/9.6 = 0.854. After adding the symmetric prior (W=2, a=0.5), it becomes (9.2, 2.4) with mean 9.2/11.6 = 0.793. The shift is ~6 percentage points. A claim with only a few observations shifts much more — raw (2, 1) had mean 0.667; post-migration (3, 2) has mean 0.600.

**Consequences:**

- Threshold queries (e.g., `σ_{confidence > 0.7}`) reclassify claims. Some that passed pre-migration will now fail.
- Confidence-ordering between claims can change. Low-evidence claims shift more than high-evidence ones, so relative ranking is not preserved.
- Any downstream system that cached or branched on point-estimate confidence values is affected.

**Migration options:**

1. *Accept the shift* (recommended). The corrected math is more correct; recalibrate downstream thresholds if needed.
2. *Preserve effective confidence at migration.* Choose post-migration (α, β) to preserve each claim's pre-migration mean. This drops uniform prior weight but preserves threshold semantics.
3. *Tag and defer.* Mark v0.1 claims with `schema_version=v0.1` and apply corrected math only to v0.1.1+ claims. Hard to maintain long-term; the wrong-math interpretation persists.

Implementations choosing option 1 (recommended) should communicate the threshold-shift to consumers before the migration runs. Implementations choosing option 2 should document the per-claim effective W explicitly. Option 3 is discouraged.

---

## 2. Correct the subjective-logic bridge (§4.4)

### 2.1 The error

v0.1 §4.4 gave the bridge from Beta(α, β) to a subjective-logic opinion as:

```
belief(P) = α / (α + β + W)        [WRONG]
belief(¬P) = β / (α + β + W)       [WRONG]
uncertainty = W / (α + β + W)      [WRONG]
```

These formulas double-count W and produce non-zero belief for an uninformative prior. Worked example: Beta(1, 1) with W = 2 yields belief 0.25, uncertainty 0.5 — but the correct vacuous opinion for a no-evidence claim is belief 0, uncertainty 1.

### 2.2 The correction

The correct bridge, under the convention pinned in §1 above:

```
belief(P)     = (α − a·W) / (α + β) = r / (r + s + W)
disbelief(P)  = (β − (1−a)·W) / (α + β) = s / (r + s + W)
uncertainty   = W / (α + β) = W / (r + s + W)
base_rate(P)  = a
projected_probability(P) = α / (α + β)
```

Note that α + β = r + s + W (by the convention pinned above), so the denominator in the corrected formulas is the *evidence total including prior*, computed directly from α + β.

Worked example with the correction: Beta(1, 1) under symmetric prior (a = 0.5, W = 2):
- r = α − a·W = 1 − 1 = 0
- s = β − (1−a)·W = 1 − 1 = 0
- belief = 0 / 2 = 0
- disbelief = 0 / 2 = 0
- uncertainty = 2 / 2 = 1
- projected probability = 1 / 2 = 0.5

This is the correct vacuous opinion: no belief either way, full uncertainty, base-rate-driven expected probability.

### 2.3 Generalization to Dirichlet

For Dirichlet(α₁, ..., αₖ) over frame {x₁, ..., xₖ} with base rates a₁, ..., aₖ:

```
belief(xᵢ)    = (αᵢ − aᵢ·W) / (Σαⱼ)
uncertainty   = W / (Σαⱼ)
base_rate(xᵢ) = aᵢ
projected_probability(xᵢ) = αᵢ / (Σαⱼ)
```

Same shape as the binary case, generalized to k categories. The vacuous-opinion property holds: Dirichlet(W·a₁, ..., W·aₖ) yields zero belief on every singleton and full uncertainty.

**Note on W scaling for larger frames.** The W=2 default from §1.2 is tuned for binary frames. For frames with k > 2 categories, the per-category prior weight is W/k (with symmetric base rate aᵢ = 1/k). With W=2 and k=5, each category receives prior weight 0.4 — a very weak prior. Consumers using large frames should consider scaling W with frame size; Jøsang's literature uses both W = 2 (constant) and W = k (scales with frame) depending on application. The corpus schema MAY override W per-key for keys with declared multi-category value schemas. When the schema does not override, W=2 applies regardless of frame size, with the caveat that prior strength diminishes per category as frame size grows.

### 2.4 Dempster-Shafer mass functions

A subjective-logic opinion converts to a Dempster-Shafer mass function on the frame:

```
mass({xᵢ})        = belief(xᵢ)                    for each singleton i
mass({x₁, ..., xₖ}) = uncertainty                  on the universal set
mass(∅)           = 0                              by definition
```

Combination of two opinions using Dempster's rule operates on the mass functions, then converts back to an opinion (or directly to combined Beta/Dirichlet parameters using the inverse of the bridge above).

References: Jøsang, *Subjective Logic* (Springer, 2016), chapters 3 and 6, for the formal treatment of binomial and multinomial opinions and their bridge to Dempster-Shafer theory.

---

## 3. Correct Dempster combination claims (§4.8/§4.9)

### 3.1 The error

v0.1 stated that Dempster's rule of combination "is commutative; associativity holds in the 'normal' cases but can be order-sensitive when conflict mass is high." This was carried forward in early drafts.

**This is wrong.** Dempster's rule is unconditionally commutative AND associative. The high-conflict phenomenon (Zadeh's example: two sources strongly supporting different singletons combine to produce strong support for a third singleton) is *counterintuitive*, not non-associative.

### 3.2 The correction

The correct statement of Dempster's rule properties:

- **Commutative**: m₁ ⊕ m₂ = m₂ ⊕ m₁
- **Associative**: (m₁ ⊕ m₂) ⊕ m₃ = m₁ ⊕ (m₂ ⊕ m₃)
- **Has identity**: the vacuous mass function (all mass on the universal set) is the identity element
- **Not idempotent**: m ⊕ m ≠ m in general — combining a mass function with itself increases certainty, which is incorrect when re-ingesting the same evidence (see §6 below)
- **High-conflict behavior**: Counterintuitive results are possible when sources strongly disagree (Zadeh's paradox). This is a property of the rule, not a failure of associativity. Alternative combination rules (Yager, Dubois-Prade, conjunctive consensus) handle high conflict differently.

### 3.3 Implication for query optimization

Implementations that applied non-associativity-based query rewrites under v0.1's claim should re-examine optimizer behavior. Dempster combinations are freely reorderable; the optimizer can group combinations in any order without changing semantics.

---

## 4. Value predicates in the selection language (§4.2)

### 4.1 The error

v0.1 §4.2 listed the predicate language: relational on key/subject/scope, probabilistic on confidence, temporal, tag, status, compound boolean. **The list did not include value predicates.**

This is presented as a "missing feature" but it is more honestly a bug in the published claim. v0.1 §3.2 declares `valueSchemas` in the corpus schema. The implicit promise of declared value schemas is that values can be queried per their declared structure. v0.1 §4.2 silently omits the predicate forms that would deliver on that promise.

Consumers attempting to query `value.amount > 5000` or `value.status = "denied"` cannot do so under v0.1 as written. Any meaningful use of `valueSchemas` is blocked.

### 4.2 The correction

§4.2's predicate language is extended to include value predicates:

```
-- Value path predicates
σ_{value.path = X}                  -- equality on a path within the value
σ_{value.path > X}                  -- comparison (gt, gte, lt, lte)
σ_{value.path ∈ S}                  -- set membership
σ_{value.path matches regex}        -- regex match on string-valued paths
σ_{value.path is null}              -- null check
σ_{value.path exists}               -- path existence check

-- Whole-value predicates
σ_{value = X}                       -- equality for primitive-valued claims
σ_{value matches pattern}           -- structural pattern match
```

Path syntax follows JSON-path conventions: dotted access (`value.amount.currency`), array indexing (`value.items[0]`), wildcard array (`value.items[*]`). Recursive wildcards are not supported.

When the corpus declares a value schema for the key, the library MUST perform parse-time type checking against the schema and reject predicates that:
- Reference fields not in the schema
- Compare incompatible types
- Use enum values not in the declared enum

When no schema is declared, predicates are dynamically typed. Runtime type mismatches produce typed errors, not silent empty results.

### 4.3 Equational laws

Value predicates compose with the rest of the predicate language and respect the standard laws:

- Commutativity with other selections holds when paths are unambiguous
- Push-down through joins, temporal slicing, and decay holds for predicates not referencing those operators' fields

### 4.4 Storage adapter classification

Value-predicate support is a per-(adapter, predicate-kind) capability. Different predicate kinds have different indexing characteristics even within the same adapter — Postgres indexes equality and containment via GIN but falls back to scans for regex. The adapter contract is extended:

```
AdapterCapabilities {
  ...
  valuePredicateSupport: Map<PredicateKind, ValuePredicateLevel>
}

PredicateKind =
  | equality                 -- value.path = X
  | range                    -- value.path > X, value.path < X, comparison operators
  | set_membership           -- value.path ∈ S
  | regex                    -- value.path matches regex
  | structural_pattern       -- whole-value pattern matching
  | null_check               -- value.path is null / exists

ValuePredicateLevel =
  | native_indexed           -- adapter has indexes that accelerate this predicate kind
  | native_unindexed         -- adapter evaluates this predicate kind via scan
  | fallback_in_memory       -- library retrieves candidates and filters after retrieval
  | unsupported              -- adapter rejects queries with this predicate kind
}
```

Reference adapter capability matrix:

| Adapter | equality | range | set_membership | regex | structural | null_check |
|---|---|---|---|---|---|---|
| Postgres (JSONB+GIN) | native_indexed | native_unindexed* | native_unindexed | native_unindexed | native_unindexed | native_indexed |
| DuckDB | native_indexed | native_indexed | native_indexed | native_unindexed | native_unindexed | native_indexed |
| SQLite (JSON1) | native_unindexed | native_unindexed | native_unindexed | native_unindexed | native_unindexed | native_unindexed |
| ChromaDB | fallback_in_memory | fallback_in_memory | fallback_in_memory | fallback_in_memory | fallback_in_memory | fallback_in_memory |
| Markdown vault | fallback_in_memory | fallback_in_memory | fallback_in_memory | fallback_in_memory | fallback_in_memory | fallback_in_memory |

*Postgres range queries on JSONB paths can be indexed via expression indexes (`CREATE INDEX ... ON corpus ((value->>'amount')::numeric)`) but require explicit setup per path.

The query optimizer chooses evaluation strategy per predicate kind and per adapter:
- `native_indexed`: push predicate to adapter, accept index cost
- `native_unindexed`: push predicate to adapter, accept full-scan cost
- `fallback_in_memory`: retrieve candidates via indexed predicates first, filter unindexed value predicates in memory; emit warning if working set is large
- `unsupported`: reject the query at parse time

**Important consumer-facing implication:** reading "Postgres supports native_indexed value predicates" as "all value predicates are cheap on Postgres" is wrong. Postgres equality on JSONB paths is fast; regex on the same paths is full-scan. Production query planning must consult the per-kind matrix, not just the adapter summary.

Consumers should structure queries to use indexed predicate kinds where possible. A logical filter that can be expressed as either equality or regex should use equality. A logical filter that requires regex should expect scan performance regardless of adapter.

Consumers MUST be informed of fallback-mode costs. Production queries against `fallback_in_memory` adapters that retrieve large working sets are operational hazards and should be visible in query plan output.

### 4.5 Backend choice guidance

The fallback-mode classification means backend choice matters. Guidance for v0.1.1 consumers:

| Workload pattern | Recommended adapter |
|---|---|
| Value-predicate-heavy (structured data filtering) | Postgres or DuckDB |
| Similarity-heavy (semantic retrieval) | Vector DB |
| Mixed structured + similarity | Hybrid adapter with routing |
| Low-volume, human-edited artifacts | Markdown vault (Stoa-style) |
| Embedded, single-process | SQLite |

Choosing a similarity-optimized adapter for a structured-query workload, or vice versa, produces queries that work correctly but perform pathologically. The optimizer cannot fix backend choice mismatch.

---

## 5. Pin embedding model and similarity function versions in derivation provenance (§6.6)

### 5.1 The error

v0.1 §6.6 committed to reproducibility of derived claims: a consumer can re-run the serialized query against the recorded corpus state and verify the result. The provenance schema records the query expression and the corpus state.

It does not record the *version* of the similarity functions or embedding models used during query evaluation. Any derivation that involved `ρ_cosine` (or any similarity-based operator) depends on the embedding model used at derivation time. Embedding models change over time, get retrained, get replaced. A serialized query that references "cosine similarity" without a model version cannot be deterministically replayed.

This makes v0.1's reproducibility guarantee undeliverable for any derivation involving similarity-based ranking — which is almost all interesting derivations.

### 5.2 The correction

Derivation provenance is extended to record similarity-function and embedding-model versions. The `DerivationProvenance` type from v0.1 §2.6 is extended:

```
DerivationProvenance {
  queryExpression  : SerializedAlgebraExpression
  corpusState      : LogicalTimestamp
  combinationRule  : string
  inputClaims      : Set<ClaimId>
  
  -- New fields in v0.1.1:
  similarityVersions : Map<SimilarityFunctionId, Version>
  embeddingModelVersions : Map<EmbeddingModelId, Version>
  evaluationClock  : Instant       -- pinned eval time for time-dependent operators
}
```

`similarityVersions` records the version of every similarity function used in the query. The library tracks similarity-function versions in its catalog.

`embeddingModelVersions` records the version of every embedding model used. When `ρ_cosine` is invoked, the embedding model's version identifier is included in provenance.

`evaluationClock` pins the time at which time-dependent operators (decay, `τ_now`) are evaluated. This eliminates "decay drift" during replay — re-evaluation uses the pinned clock, not the current clock.

### 5.3 Replay semantics

§6.6's reproducibility guarantee is corrected to be conditional on version availability:

A consumer can re-run the serialized query against the recorded corpus state and verify the result *iff*:
1. All input claims are present in the corpus
2. All similarity function versions referenced in provenance are available in the catalog
3. All embedding model versions referenced in provenance are available
4. The evaluationClock is used for time-dependent operators

When any of these conditions fails, replay produces a defined degraded result:

```
ReplayResult {
  status: ReplayStatus
  result: Claim?
  missingDependencies: List<MissingDependency>
}

ReplayStatus =
  | exact                    -- all conditions met, result matches recorded
  | unavailable_models       -- provenance recorded model versions, but those versions are no longer available
  | missing_inputs           -- provenance recorded input claim IDs, but those claims are no longer present
  | integrity_unknown        -- derivation was committed before mandatory provenance fields existed (v0.1-era); cannot verify
  | failed                   -- replay fundamentally cannot proceed
```

### 5.4 Mandatory provenance for derived writes

`commit_derived` (v0.1 §6.6) MUST populate `similarityVersions` and `embeddingModelVersions` when the query expression references similarity-based operators. A derived write that omits these fields when the query requires them is invalid and MUST be rejected.

For v0.1-era derived claims that lack these fields: the library treats their replay status as `integrity_unknown` — distinguishing "we committed without recording what we needed" from `unavailable_models` ("we recorded versions but those versions are gone now"). There is no path to retroactively add the missing version information. Consumers needing reproducibility for these claims must re-derive them under v0.1.1.

### 5.5 Why this is irreversible-if-skipped

The decision to record version information is *irreversible at write time*. A derivation committed without versions cannot retroactively gain them — the information is gone. This is unlike most v0.2 capability additions, which can be retrofitted as forward extensions.

Implementations adopting v0.1.1 MUST start recording version information immediately, even if the broader replay-verification machinery is not yet built. Recording without using is cheap; not recording forecloses future use.

---

## 6. Non-idempotence warnings on combination operators (§4.8/§4.9)

### 6.1 The error

v0.1 §4.9 specified combination rules (Dempster, weighted-average, max-confidence, evidence-pooled) and listed properties in §4.8 (commutative, associative). It did not flag *non-idempotence* — the property that combining a claim with itself produces a different (more certain) result than the original claim.

Real systems hit this when retries, replays, duplicate event detection, or batch reprocessing cause the same evidence to be combined multiple times. The result is fabricated certainty: a measurement with variance σ², ingested twice, appears to have variance σ²/2.

### 6.2 The correction

§4.8's properties table is extended with an idempotence column, with the rule_max_confidence split addressed in §11 below:

| Rule | Commutative | Associative | Idempotent |
|---|---|---|---|
| `rule_weighted_avg` | ✓ | ✓ | ✓ |
| `rule_evidence_pooled` | ✓ | ✓ | ✗ |
| `rule_max_mean` (§11) | ✓ | ✓* | ✓ |
| `rule_max_concentration` (§11) | ✓ | ✓* | ✓ |
| `rule_dempster` | ✓ | ✓ | ✗ |
| `rule_kalman` (when introduced) | ✓ | ✓ | ✗ |

*Associativity of the max-selection rules depends on tie-breaking semantics. With a stable, total tie-breaker (e.g., lexicographic on claim ID), they are associative.

**The evidence-combining rules — `rule_evidence_pooled`, `rule_dempster`, `rule_kalman` — are non-idempotent.** Re-ingesting the same evidence inflates certainty incorrectly under these rules. The averaging and max-selection rules (`rule_weighted_avg`, `rule_max_mean`, `rule_max_concentration`) are idempotent — averaging a value with itself returns the value; selecting the maximum of a value against itself returns the value. This is the semantic distinction between *averaging* (normalizes), *selecting* (no combination), and *pooling* (accumulates).

### 6.3 Recommended mitigation

The library should provide observation-deduplication facilities at the application layer. Consumers attach `observation_id` fields to evidence sources. Before combination, the library deduplicates by observation_id within the input claim set.

This is application-level discipline, not an algebra correction. The spec recommends but does not enforce.

For Beta-distributed claims combined via `rule_evidence_pooled`: consumers should ensure that the (α, β) parameters of input claims reflect *distinct* evidence. If two claims share underlying observations, the pooled result is incorrect.

For Gaussian-distributed claims combined via `rule_kalman` (when introduced): the same caveat applies, and is especially dangerous because Kalman fusion narrows variance every time, with no upper bound on how much fabricated certainty accumulates from repeated identical inputs.

---

## 7. Specify scalar-to-Beta conversion (§4.7)

### 7.1 The error

v0.1 §4.7 specified mixed-distribution combination: "Beta confidence + scalar confidence → coerce scalar to Beta with informative prior, then combine." It did not specify *which* informative prior.

A scalar of 0.8 maps to Beta(8, 2) and to Beta(80, 20) with the same mean but ten times the evidence weight. The choice silently determines how much a scalar-source claim dominates in subsequent pooling.

### 7.2 The correction

Scalar-to-Beta conversion requires an explicit declared pseudo-count. The conversion is:

```
scalar_to_beta(scalar, pseudocount, base_rate):
  α = scalar × pseudocount + base_rate × W
  β = (1 − scalar) × pseudocount + (1 − base_rate) × W
```

Where `pseudocount` is the strength-of-evidence the scalar represents, expressed as effective observation count, and `W`, `base_rate` are the corpus's prior parameters from §1.2.

The `pseudocount` parameter is *required*, not defaulted. Either:

1. The corpus schema declares per-source pseudocounts: `scalarPseudocount: Map<Source, Number>`
2. The conversion operator takes pseudocount as an explicit argument

Implementations MUST NOT default the pseudocount silently. A combination operation that requires scalar-to-Beta coercion without a declared pseudocount MUST fail at parse time.

### 7.3 Recommended defaults

For consumers needing guidance on pseudocount choice:

- Sources with high trust (manual, verification): pseudocount ≥ 10 (treat each scalar as having substantial evidence backing)
- Sources with medium trust (workflow, heuristic): pseudocount ≈ 5
- Sources with low trust (llm, imported): pseudocount ≈ 2 (treat scalar as weak evidence)

These are *guidance only*. Consumers should calibrate to their domain.

---

## 8. Other corrections

### 8.1 Reserved scope field for similarity context

The reserved scope field list in v0.1 Appendix C is extended with one field:

```
- modelId   -- LLM model associated with the claim (already present in v0.1)
- embeddingModelId  -- (new) embedding model associated with similarity-based provenance
```

This makes embedding-model attribution queryable as a structured scope, in addition to its inclusion in derivation provenance.

### 8.2 §6.6 reproducibility language

The blanket reproducibility claim in v0.1 §6.6 is replaced with the version-aware claim from §5 of this errata. Specifically:

> Removed: "Any consumer can re-run the serialized query against the recorded corpus state and verify they get the same derived claim."
>
> Replaced with: "A consumer can re-run the serialized query against the recorded corpus state and verify the result, conditional on the availability of all referenced model versions, similarity-function versions, and input claims at replay time. The library defines stratified replay status for cases where conditions are not met."

### 8.3 §6.1 write pipeline performance language

v0.1 §6.1 specified a two-phase candidate→promotion→commit pipeline without performance guidance. v0.1.1 clarifies:

> The pipeline described is a *correctness* model. Implementations MAY batch, parallelize, or pipeline the stages provided that the observable behavior — atomic visibility, durability, contradiction checking semantics — is preserved. High-throughput consumer workloads (>1000 writes/sec) typically require batched promotion with parallel commit threads. The reference SQLite adapter is single-writer and is not appropriate for such workloads; the reference Postgres adapter supports parallel writers via MVCC.

### 8.4 §2.3 scopeHash for empty scope

v0.1 §2.3 specified scopeHash computation but did not state the value for an empty scope. v0.1.1 fixes:

> The scopeHash of an empty scope is `"_"` (a single underscore character). This is the same convention used historically in RaState's claim store and is preserved here for consistency.

### 8.5 §2.3 uniqueness of (profile, key, scopeHash)

v0.1 §2.3 implied but did not state whether (profile, key, scopeHash) is a unique key or a non-unique index. v0.1.1 clarifies:

> (profile, key, scopeHash) is a *non-unique index*. The unique primary key on a claim is the `id` field. Multiple claims may share the (profile, key, scopeHash) triple — typically because one is currently validated and others are deprecated supersession history. Queries that need "the currently-validated claim with this triple" must filter by status; the algebra's standard `σ_status=validated` does this.

This affects v0.1 §6.1's contradiction-checking pipeline: the cheap contradiction check on (profile, key, scopeHash) match must additionally filter by status to find the currently-validated competing claim, not just any historical claim.

---

## 9. Summary of changes

| Section | Change | Severity |
|---|---|---|
| §1 — α,β convention | Pinned to standard subjective-logic relation with prior weight W and base rate a; migration semantic-shift documented | Critical — affects all combination math |
| §2 — SL bridge | Corrected formulas; added Dirichlet generalization with W-scaling note | Critical — produces wrong opinions otherwise |
| §3 — Dempster claims | Corrected to unconditional associativity; added non-idempotence | High — affects optimizer correctness |
| §4 — Value predicates | Added to §4.2; type-checked against valueSchemas; per-(adapter, predicate-kind) capability matrix | High — blocks meaningful use of valueSchemas |
| §5 — Version pinning | Added similarityVersions, embeddingModelVersions, evaluationClock to derivation provenance; added integrity_unknown ReplayStatus | Critical — irreversible-if-skipped |
| §6 — Idempotence | Added idempotence column to properties table; documented combination hazard; updated for rule_max split | High — silent semantic errors otherwise |
| §7 — Scalar conversion | Required explicit pseudocount; rejected silent defaulting | Medium — affects mixed-distribution semantics |
| §8 — Various | Minor clarifications to scope hashing, write pipeline, primary key semantics | Low — clarifies ambiguity |
| §10 — Beta pooled correction | Fixed convention-propagation bug in rule_evidence_pooled for Beta; documented N-input generalization | Critical — wrong-answer bug under pinned convention |
| §11 — rule_max split | Deprecated ambiguous `rule_max_confidence`; replaced with `rule_max_mean` and `rule_max_concentration` | High — breaking change required for protocol contract |
| §12 — Convention propagation check | Process discipline: explicit re-derivation table for every operation depending on pinned convention | Process — prevents the bug-class that motivated §10 and §11 |

### 9.1 Required actions for v0.1 implementers

Before deploying any v0.1 implementation to production:

1. **Adopt the pinned α,β convention.** Document in implementation which W and base_rate are used.
2. **Replace the SL bridge formulas.** Existing computations using v0.1's formulas are wrong.
3. **Correct Dempster optimizer claims.** Remove associativity hedges.
4. **Add value predicate support.** Implement at least one storage adapter with the per-(adapter, predicate-kind) capability matrix.
5. **Begin recording version information in derivation provenance immediately.** Even if the broader replay machinery is not built, record the data so it exists for future use.
6. **Document non-idempotence in operator selection.** Provide observation-deduplication guidance to consumers.
7. **Require explicit scalar pseudocount.** No silent defaults.
8. **Specify scopeHash for empty scope and primary-key semantics.** Match implementation to specification.
9. **Apply the rule_evidence_pooled correction for Beta.** v0.1's "sum the underlying Beta parameters" is wrong under the pinned convention. Use the prior-subtraction formula from §10.3.
10. **Migrate from `rule_max_confidence` to `rule_max_mean` or `rule_max_concentration`.** The library MUST reject queries referencing the deprecated rule with a typed error that guides consumers to the correct replacement.
11. **Run the convention propagation check (§12) before any future spec revision.** Any pinning or correction of a foundational convention must include re-derivation status for every operation touching the changed quantity.

These actions hold regardless of which (if any) v0.2 capabilities are adopted.

---

## 10. Convention propagation: rule_evidence_pooled correction for Beta

### 10.1 The error

v0.1 §4.9 specified `rule_evidence_pooled` for Beta-distributed confidence as "sum the underlying Beta parameters." Under v0.1's unpinned convention, this was ambiguous — implementations interpreting α, β as raw counts (without prior) would pool correctly; implementations interpreting α, β as prior-inclusive (the convention v0.1.1 §1 now pins) would double-count the prior.

The v0.2 protocol-tier Dirichlet implementation in §3.3 correctly specifies prior-W subtraction to avoid double-counting. But the corresponding Beta rule in v0.1 §4.9 was never updated to match. This means core Beta consumers under v0.1.1 apply the wrong rule, and the rule disagrees with its Dirichlet counterpart — violating the protocol-uniform-rule-name contract that v0.2 §3.4 spent considerable space defending.

This is convention-propagation: when v0.1.1 §1 pinned α = r + a·W, every rule that operates on α should have been re-derived under the new convention. `rule_evidence_pooled` was not.

### 10.2 The worked example

Two claims, each Beta(3, 2) with W=2, a=0.5. Under the pinned convention each represents r=2 positive observations and s=1 negative observation (since α = r + a·W = 2 + 1 = 3, β = s + (1-a)·W = 1 + 1 = 2).

Correct pooling (sum raw evidence, re-add one prior):
- r_pooled = 2 + 2 = 4
- s_pooled = 1 + 1 = 2
- α_pooled = r_pooled + a·W = 4 + 1 = 5
- β_pooled = s_pooled + (1-a)·W = 2 + 1 = 3
- Result: Beta(5, 3), mean 0.625, concentration 8

Naive sum (v0.1 §4.9 as written under pinned convention):
- α_naive = 3 + 3 = 6
- β_naive = 2 + 2 = 4
- Result: Beta(6, 4), mean 0.600, concentration 10

The naive sum carries one extra W of phantom evidence — exactly the prior-W amount, double-counted.

Correct closed-form (matching v0.2 §3.3 Dirichlet):
- α_pooled = α₁ + α₂ − a·W = 3 + 3 − 1 = 5
- β_pooled = β₁ + β₂ − (1-a)·W = 2 + 2 − 1 = 3
- Result: Beta(5, 3). ✓ Matches the correct pooling.

### 10.3 The correction

`rule_evidence_pooled` for Beta(α₁, β₁) and Beta(α₂, β₂) under pinned convention with prior weight W and base rate a:

```
α_pooled = α₁ + α₂ − a·W
β_pooled = β₁ + β₂ − (1-a)·W
```

This is mathematically identical to "extract raw r, s from each input; sum raw counts; re-add one prior." Both formulations produce the same result.

### 10.4 N-input generalization

For pooling N Beta claims in a single call:

```
α_pooled = (Σ αᵢ) − (N−1) · a · W
β_pooled = (Σ βᵢ) − (N−1) · (1-a) · W
```

The `(N−1)` factor reflects that N inputs carry N priors, and the pooled result should carry exactly one. Pooling pairwise in any order gives the same result by associativity (verified: pooling three Beta(3,2) values pairwise produces Beta(5,3) then Beta(7,4); the closed-form gives 3·3 − 2·1 = 7 for α and 3·2 − 2·1 = 4 for β — same result).

Implementations should use the closed-form for N inputs rather than pairwise reduction, to avoid floating-point accumulation error and to make the prior-subtraction explicit.

### 10.5 Why this matters beyond mathematical correctness

This finding is the original convention-pinning bug surviving in a different operator. The audit cycle catches errors by operator name. When v0.1.1 §2.2 corrected the SL bridge, every operator that depends on the convention should have been individually re-derived. `rule_evidence_pooled` was not, and silently carried the pre-pinning interpretation forward.

Process implication for future revisions: **when a convention is pinned or corrected, the revision MUST include explicit re-derivation of every operator that touches the changed quantity.** Reconciling audit findings by operator name catches the audited operator; it does not catch operators that depend on the same convention but weren't individually flagged. The convention change is graph-level; audit findings are node-level. Re-deriving by node leaves edges unfixed.

§12 below records the convention propagation check this lesson motivated.

---

## 11. Convention propagation: rule_max_confidence ambiguity resolution

### 11.1 The error

v0.1 §4.9 named the operator `rule_max_confidence` and described it as "highest-confidence value wins." The wording suggests max-mean (highest point estimate). The errata never pinned the criterion. v0.2 §3.3 quietly committed Dirichlet to "argmax over total concentration Σαᵢ (the most-informed opinion wins)" — which is max-concentration, not max-mean.

The two semantics diverge. Beta(9, 1) has mean 0.9 and concentration 10. Beta(80, 20) has mean 0.8 and concentration 100. Max-mean picks the first; max-concentration picks the second. These are different operations serving different purposes:

- *Max-mean* answers: "which input has the highest point-estimate value?" Used when you want to surface the most confident-sounding claim regardless of evidence backing.
- *Max-concentration* answers: "which input has the most evidence behind it?" Used when you want to prefer well-evidenced claims over noisy ones with high point estimates.

The current state — name says one thing, Dirichlet implementation says another, Beta criterion unpinned — is incoherent and violates the protocol-uniform-rule-name contract v0.2 §3.4 established.

### 11.2 The resolution

`rule_max_confidence` is **deprecated as ambiguous**. It is replaced by two distinct rules, each with a clear semantic:

```
rule_max_mean          : argmax over the mean (point estimate) of each input
rule_max_concentration : argmax over the total evidence weight (concentration) of each input
```

Both rules are idempotent (argmax of a value against itself returns the value, with stable tie-breaking).

### 11.3 Per-distribution semantics

The two rules apply uniformly across distribution types, with type-appropriate definitions of "mean" and "concentration":

| Distribution | mean | concentration |
|---|---|---|
| scalar | the scalar value | (consumer-declared pseudocount per errata §7) |
| Beta(α, β) | α / (α + β) | α + β |
| Dirichlet(α₁, ..., αₖ) | per-category α_i / Σαⱼ; rule_max_mean picks input with highest max-category mean | Σαⱼ |
| Gaussian(μ, σ²) | μ | 1/σ² (precision) |

For Dirichlet under `rule_max_mean`: the rule picks the input whose *most-likely category* has the highest mean across all inputs. Ties (multiple inputs whose top category has the same mean) are broken by claim ID.

For Gaussian under `rule_max_concentration`: precision = 1/σ², so lowest-variance wins. This is the semantic the previous v0.2 §3.4 entry called "lowest-variance argument wins (most-precise opinion selected)" — relabeled to use the unambiguous name.

For Gaussian under `rule_max_mean`: argmax over μ. This is rarely what consumers want for Gaussian inputs (it's just "argmax position") but it's provided for consistency. Documentation should note it's unusual.

### 11.4 Tie-breaking

All max-selection rules require a stable, total tie-breaker for associativity. The library uses lexicographic ordering on claim ID as the default tie-breaker. Consumers can override per-corpus via schema configuration.

Ties under `rule_max_mean` for Dirichlet specifically: when two inputs have the same max-category mean, the tie-breaker applies. When two inputs have the same max-category mean but for *different categories* (e.g., one input is Dirichlet(8, 1, 1) — mean 0.8 on category A; another is Dirichlet(1, 8, 1) — mean 0.8 on category B), they are still tied under `rule_max_mean` and the tie-breaker chooses.

### 11.5 Migration from v0.1 rule_max_confidence

This is a **breaking change** for v0.1 consumers that used `rule_max_confidence`. The library MUST:

1. Reject any query or write referencing `rule_max_confidence` with a typed error
2. The error message MUST include both replacement rule names and a brief description of the semantic distinction
3. Documentation MUST guide consumers to choose `rule_max_mean` (if they want point-estimate selection) or `rule_max_concentration` (if they want evidence-weight selection)

Implementations migrating from v0.1 should audit existing usage of `rule_max_confidence` and replace explicitly. Silent migration (defaulting to one of the two new rules) is forbidden because it would mask incorrect usage where the consumer wanted the other semantic.

### 11.6 Why split rather than pin

The natural question: why not just pin `rule_max_confidence` to one semantic and rename later? Because either pinning silently surprises consumers who relied on the other interpretation. There's no consumer-friendly default — the two semantics are genuinely different. Splitting now and forcing explicit choice is the principled fix; the breaking change is the cost of restoring the protocol contract.

This is the same logic that drove the Gaussian de-aliasing in v0.2 §3.4: when two operations have different semantics, they need different names. Aliasing or silent defaulting collapses real semantic distinctions and creates the conditions for future audit findings.

---

## 12. Convention propagation check

This section documents the explicit re-derivation of every operation that depends on the pinned α, β convention from §1. This is the process discipline motivated by Findings 1 and 2 from the v0.1.1 fourth-audit review — convention changes are graph-level; audit findings are node-level; re-deriving every node prevents the auditor's "original bug wearing different clothes" pattern.

### 12.1 The convention

From §1.2: α = r + a·W, β = s + (1-a)·W, where r is positive evidence count, s is negative evidence count, W is non-informative prior weight, a is base rate. Default W=2, a=0.5.

### 12.2 Operations that depend on this convention

For each operation, the table records whether it has been re-derived under the pinned convention and where the verified specification lives.

| Operation | Specification location | Re-derivation status |
|---|---|---|
| Effective confidence (mean) | v0.1 §2.4: α/(α+β) | ✓ Verified — formula α/(α+β) applies under the pinned convention; value is convention-dependent (see §1.3 migration shift), NOT neutral. The same symbol string evaluates differently under raw-counts vs. prior-inclusive interpretations — which is precisely why §1 had to pin the convention. |
| SL bridge from Beta | Errata §2.2 | ✓ Verified — derivation: belief = (α − a·W)/(α+β) = r/(r+s+W) explicitly subtracts the prior portion from α to recover raw evidence r before normalization. Worked example for Beta(1,1) under W=2, a=0.5: r = 1−1 = 0, s = 1−1 = 0, belief = 0, uncertainty = W/(α+β) = 2/2 = 1.0 ✓ (vacuous opinion as required). |
| SL bridge from Dirichlet | Errata §2.3 | ✓ Verified — generalized formulas; vacuous-opinion property checks: Dirichlet(W·a₁, ..., W·aₖ) → belief(xᵢ) = (W·aᵢ − aᵢ·W)/W = 0 for every singleton; uncertainty = W/W = 1.0 ✓. W-scaling note added for frames with k > 2. |
| `rule_evidence_pooled` for Beta | Errata §10 (this revision) | ✓ Verified — derivation: under pinned convention, α₁ + α₂ = (r₁ + a·W) + (r₂ + a·W) = (r₁+r₂) + 2·a·W. Two priors accumulated. Subtracting one prior-W gives (r₁+r₂) + a·W, which is the correct prior-inclusive form for the pooled evidence. Worked example: Beta(3,2) + Beta(3,2) under W=2, a=0.5 → α_pooled = 3+3−1 = 5, β_pooled = 2+2−1 = 3, Beta(5,3) ✓. |
| `rule_evidence_pooled` for Dirichlet | v0.2 §3.3 | ✓ Verified — same derivation generalized to k categories: pooling N inputs accumulates N priors; subtract N−1 to retain exactly one. v0.2 §3.3 specifies this explicitly. |
| `rule_weighted_avg` for Beta | v0.1 §4.9 | ✓ Verified — derivation: weights w₁+w₂=1, so w₁α₁ + w₂α₂ = w₁(r₁ + a·W) + w₂(r₂ + a·W) = (w₁r₁ + w₂r₂) + a·W. Exactly one prior carries through. Convention-neutral because the result preserves the same single-prior structure as the inputs. This is precisely the property that distinguishes averaging from pooling (which needed §10's correction). |
| `rule_weighted_avg` for Dirichlet | v0.2 §3.3 | ✓ Verified — same derivation as Beta, generalized to k categories: Σwⱼα_ij = Σwⱼ(rⱼ + aⱼ·W) = Σwⱼrⱼ + aⱼ·W. One prior carried through per category. |
| `rule_weighted_avg` for Gaussian | v0.2 §3.4 | ✓ Verified — Gaussian operations don't depend on Beta convention; moment-matched mixture math (§3.4) is convention-independent because Gaussians don't have a prior-vs-evidence decomposition |
| `rule_max_mean` (all types) | Errata §11 (this revision) | ✓ Verified — max over α/(α+β). Derivation: the ratio's *value* is convention-dependent (per the mean row above), but the *ordering* under a single pinned convention is well-defined. Counter-example showing ordering is NOT convention-neutral: Beta with raw (r=8,s=0) and Beta with raw (r=2,s=0) — both have raw mean 1.0 (tied), but prior-inclusive means 9/10=0.9 and 3/4=0.75 (first wins). Convention-fixed within an implementation; cross-implementation comparisons require both to use the same convention. |
| `rule_max_concentration` (all types) | Errata §11 (this revision) | ✓ Verified — max over α+β (Beta) or Σαⱼ (Dirichlet). Derivation: convention adds a constant W to every input's concentration (α+β = r+s+W under prior-inclusive vs r+s under raw counts). Adding the same constant to every value preserves the ordering. Genuinely convention-neutral on the ordinal result; convention-dependent only on the absolute value. |
| `rule_dempster` via SL bridge | Errata §2.4 | ✓ Verified — derivation: Dempster's combination operates on mass functions; mass functions are derived from SL opinions via §2.4's bridge; SL opinions are derived from Beta/Dirichlet via §2.2/§2.3. Convention-correctness propagates through the chain because each conversion step uses the corrected formulas. The combination itself does not touch α,β directly. |
| `rule_kalman` for Gaussian | v0.2 §3.4 | ✓ Verified — Gaussian operations don't depend on Beta convention. Kalman uses (μ, σ²) which has no prior-vs-evidence decomposition. Convention-independent. |
| `scalar_to_beta` conversion | Errata §7.2 | ✓ Verified — derivation: formula α = scalar · pseudocount + a·W explicitly constructs a prior-inclusive Beta. The `scalar · pseudocount` term is the raw-evidence contribution (treating the scalar as expectation over the pseudocount); `a·W` adds the prior. Result α + β = pseudocount + W has the correct prior-inclusive structure. |
| `α_rate` (v0.2 aggregation) | v0.2 §2.3 | ✓ Verified — derivation: emits Beta(r + a·W, s + (1−a)·W) where r, s are observed counts and W, a come from the corpus's pinned values. By construction follows the convention. v0.2 §2.3 explicitly rejects Laplace smoothing (which would use +1/+1 regardless of the corpus's W, breaking the convention). |
| `extend_to_frame` (Beta → Dirichlet) | v0.2 §3.5 | ✓ Verified — derivation in §12.3 below. |

### 12.3 extend_to_frame derivation

The fourth-audit review noted that the original `extend_to_frame` formula carried the Beta's prior into the target frame without renormalization, which was internally inconsistent when `a_binary ≠ a_A` or `W_binary ≠ W_target`. The v0.2 §3.5 revision strips the Beta's prior to recover raw counts, then redistributes under the target frame's prior structure.

Derivation: input Beta(α, β) with (W_binary, a_binary) decomposes as r = α − a_binary·W_binary, s = β − (1 − a_binary)·W_binary. Under the target frame {A, B, C} with `trueMapsTo = A`:
- α_A = r + a_A · W_target — r evidence (the Beta's "True" evidence) goes to A; A's prior is added.
- α_B = s · (a_B/(1−a_A)) + a_B · W_target — s evidence (the Beta's "False" evidence) splits proportionally to base rates; B's prior is added.
- α_C = s · (a_C/(1−a_A)) + a_C · W_target — analogous for C.

Properties (derived, not asserted):
- *Raw-evidence preserving*: Σα_i − Σ(aᵢ · W_target) = r + s · (a_B + a_C)/(1−a_A) = r + s · 1 = r + s. ✓ The raw evidence count is invariant.
- *Prior structure consistent*: each category contributes aᵢ · W_target to total concentration; sum is Σaᵢ · W_target = W_target. Result has uniform prior weight W_target.
- *Total concentration* Σα_i = (r + s) + W_target = α + β + (W_target − W_binary). Equal to α + β only when W_target = W_binary; the example's apparent exact equality is because both W's were 2.
- *Round-trip*: marginalizing back to a binary frame {A, ¬A} gives Beta(α_A, α_B + α_C) = Beta(r + a_A·W_target, s + (1−a_A)·W_target). This equals the input Beta when (a_binary, W_binary) = (a_A, W_target); otherwise it's the input's raw evidence re-paired with the target's prior structure.

The v0.2 §3.5 documentation has been updated to reflect that mass-preservation applies to raw evidence specifically, with the conditional caveat for total concentration.

### 12.4 Process commitment for future revisions

Future revisions that pin or correct a foundational convention MUST include a §12-equivalent convention propagation check listing every operation that depends on the changed quantity, with re-derivation status documented for each. Acknowledging audit findings node-by-node is not sufficient when the convention change is graph-level.

**Additionally**, each entry in the propagation table MUST include the derivation — not a hand-waved assertion. The fifth-audit review caught a false justification ("prior cancels in ratio") sitting in the table built to enforce rigor. The lesson: the table's own entries are themselves claims that need verification. A justification that asserts neutrality must show why the operation is neutral, not just declare it.

This discipline is heavier than reconciling individual audit findings, but it catches the class of error that audit-by-name misses. Finding 1 from the fourth-audit review would have been caught proactively by this discipline at the time of v0.1.1 §1.2 pinning, before it became a fifth-audit finding. Finding 1 from the fifth-audit review (false justification in the table) would have been caught by the requirement that each table entry include its derivation, not just its conclusion.

---

## End of v0.1.1 errata

This document corrects errors in the v0.1 specification. v0.2 capability proposals reference this errata as their baseline.
