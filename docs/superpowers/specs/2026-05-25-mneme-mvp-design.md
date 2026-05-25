# Mneme MVP — Implementation Design

**Date:** 2026-05-25
**Status:** Approved (brainstorming complete; pending DAG plan)
**Canonical spec:** `mneme-spec-v0.2-consolidated.md` (repo root). Section references (§) point there.
**Milestone:** MVP — the first of three (MVP → v1 Full Core → v2 Protocol extensions + profiles).

This document designs the **MVP milestone only**. It records the locked decisions, the
architecture, and — per the explicit project requirement — every place the MVP **splits a
feature** or **takes a shortcut**, mapped to the future milestone that closes it. The
"Deferred features" and "MVP shortcuts & required future work" sections (§11–§12) are
load-bearing: they are the contract that no deferred capability or known optimization is
lost between milestones.

---

## 1. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Language + runtime | **TypeScript / Node.js** | Tagged unions + interfaces map ~1:1 to the spec's sum types and protocol contracts; JSON-shaped `Value`/`Scope` pair with a runtime validator for parse-time type-checking; aligns with the AI-orchestration/MCP ecosystem the spec targets. |
| Validation | **Zod** | Backs the spec's parse-time type-checking of values, scope strictness, and value-predicate type-checks against declared `valueSchemas`. |
| Test runner | **Vitest** | Fast, TS-native, good TDD ergonomics. |
| SQLite binding | **better-sqlite3** | Synchronous, WAL, single-writer — exactly the reference-SQLite profile of §7.1/§10.1. |
| Module format / TS | **ESM, NodeNext, strict** | Modern Node library conventions. |
| Package layout | **Single package**, internal module boundaries | MVP is one cohesive library; boundaries (below) keep units small and testable. |
| MVP pipeline boundary | **Retrieve + Compose** | Full §4.1–4.7 retrieval + composition κ (§4.12), producing the LLM-ready artifact (Mneme's thesis, §1). Read-time ⊥/resolve deferred to v1. |
| Similarity functions | **Jaccard + exact** | Two pure, deterministic `SimilarityFn`s prove the registry + `defaultSimilarityFn` wiring without BM25's corpus-statistics surface. |

---

## 2. MVP scope

The smallest slice that stores typed claims and answers a real retrieval query
end-to-end against one storage adapter, producing an LLM-ready context.

**In scope (core `[C]` only):**

- **Core types** (§2): `Claim`; Subject/Key with prefix-derived subject and dynamic-key
  rejection; `Scope` with canonicalization + `scopeHash` (SHA-256 16-char prefix; empty → `"_"`);
  bitemporal `valid`/`recorded`; `Provenance` (recorded, not replayed in MVP); `EvidenceRef`
  with enforced DAG acyclicity.
- **Confidence** (§2.4–2.5): Beta + scalar; effective mean; subjective-logic bridge.
- **Distribution protocol** (§5.1): full interface; Beta + scalar bindings implement
  statistics + bridge + serialization. `combine` deferred (see §11).
- **Catalog** (§3, §6 subset): in-memory single-corpus catalog; `createCorpus`,
  `getCorpus`, `getCorpusSchema`; `ClaimSchema` with `valueSchemas`, strict `scopeFields`,
  `scalarPseudocount`; `requiredTiers = {core}` validated at startup.
- **Algebra** (§4.1–4.7, §4.12): σ, π, τ (valid/recorded/known/now), δ
  (none/exponential/linear/step), ρ (Jaccard + exact via `SimilarityFn`), γ (bounded depth),
  κ (`δ_dedup_content` / `φ_format` / `β_budget`).
- **Storage adapter** (§10): SQLite.
- **Write model** (§7.1–7.3, §7.7): immediate-promote pipeline; cheap contradiction checks
  (all four policies); idempotency.

**Acceptance:** the reduced Worked Query 1 runs end-to-end (see §10).

---

## 3. Architecture — evaluation model

**Algebra operators are pure functions over an in-memory `Corpus` value** (an immutable
array of claims plus carried metadata). The leaf `corpus(id)` loads claims from the storage
adapter; every subsequent operator is a pure transform applied in memory:

```
σ, π, τ, δ, γ : Corpus → Corpus
ρ             : Corpus → RankedCorpus
δ_dedup       : RankedCorpus → RankedCorpus
φ_format      : RankedCorpus → ComposedContext
β_budget      : ComposedContext × TokenBudget → ComposedContext
κ             : RankedCorpus × Format × TokenBudget → ComposedContext
```

The adapter is touched only (a) at the leaf and (b) by γ for evidence-by-id lookups.

**Why in-memory:** the spec states the optimizer/push-down is *never required for
correctness* (§4.14), and the SQLite value-predicate row is `native_unindexed` /
`fallback_in_memory` anyway (§10.2). This makes every operator unit-testable without a
database. The leaf MAY push down trivially-safe indexed filters (subject, key, status,
scopeHash, `recorded ≤ T`) as an optimization, but correctness never depends on it.

> **Future:** the cost-based optimizer, full predicate push-down, and the per-(adapter,
> predicate-kind) execution-strategy matrix are deferred (§12).

---

## 4. Module structure

```
src/
  core/
    ids.ts            branded ID types (ClaimId, CorpusId, ProfileId, WorkspaceId, ScopeHash, …)
    value.ts          Value (JSON-shaped) type + helpers
    time.ts           Instant, Interval [from,to), valid-time coverage
    key.ts            Subject/Key parse + validation (subject = first segment; reject dynamic keys)
    scope.ts          Scope type, canonicalization, scopeHash ("_" for empty)
    confidence.ts     Confidence type (beta|scalar), effective mean, valueHash helpers
    evidence.ts       EvidenceRef union; DAG acyclicity check
    provenance.ts     Provenance + DerivationProvenance (recorded only in MVP)
    claim.ts          Claim, Status, Source enums
  distribution/
    protocol.ts       DistributionProtocol<T> interface (full §5.1 shape)
    subjective-logic.ts  SL opinion type + bridge formulas
    beta.ts           Beta binding (mean, variance, bridge, serialize/canonicalize)
    scalar.ts         scalar binding
    registry.ts       DistributionType → binding
  catalog/
    tiers.ts          TierRequirement; deployment available-tier validation
    schema.ts         ClaimSchema, KeyPattern, value/scope field types, scalarPseudocount
    corpus.ts         Corpus, CorpusDefaults
    catalog.ts        in-memory catalog: create/get; startup requiredTiers validation
  algebra/
    types.ts          Corpus, RankedCorpus, ScoredClaim, ComposedContext
    predicate.ts      predicate AST (relational/probabilistic/temporal/tag/status/compound)
    value-predicate.ts  value path + whole-value predicates; parse-time type-check vs valueSchema
    selection.ts      σ
    projection.ts     π
    temporal.ts       τ_valid / τ_recorded / τ_known / τ_now
    decay.ts          δ_none / δ_exponential / δ_linear / δ_step
    similarity.ts     SimilarityFn protocol; sim_jaccard; sim_exact; ρ; registry wiring
    provenance-traversal.ts  γ (bounded depth, DAG walk, no duplication)
    composition.ts    δ_dedup_content; φ_format (xml/md/json/text); β_budget; κ; token counter
    expression.ts     algebra expression nodes + evaluator (resolves leaf via adapter)
  adapters/
    adapter.ts        StorageAdapter interface, AdapterCapabilities, ExecutionPlan, ChangeFilter
    sqlite.ts         SQLite adapter (better-sqlite3)
  write/
    source-weight.ts  Appendix A source weights + decay half-lives
    contradiction.ts  cheap contradiction check + 4 policies
    idempotency.ts    idempotency-key store (corpus, writer, key); 24h window
    pipeline.ts       immediate-promote: hashes → weight → validate → contradiction → assign → commit
  mneme.ts            façade: createMneme, createCorpus, commit, query
  index.ts            public exports
test/
  unit per module + end-to-end acceptance (reduced Worked Query 1)
```

---

## 5. Core types & math (§2, §5.1–5.2)

- **Claim** exactly per §2.1. `status ∈ {candidate, provisional, validated, deprecated}`;
  `source ∈ {manual, verification, workflow, heuristic, llm, imported}`.
- **Subject/Key** (§2.2): `Key` is kebab-case dotted `{subject}.{domain}[.{property}]`;
  `subject` is the first segment (never authored independently); validators reject keys with
  dynamic segments (e.g. `repo.{repoId}.test-command`).
- **Scope** (§2.3): strict — unknown fields rejected at write time against
  `schema.scopeFields`. Canonical form = sorted keys, omitted undefined, normalized strings.
  `scopeHash` = SHA-256 hex, 16-char prefix; empty scope → reserved `"_"`.
- **`(profile, key, scopeHash)` is a non-unique index**; `id` is the unique PK (§2.3).
- **Confidence** (§2.4): `{ distribution, parameters, raw, effective? }`. Effective mean
  `α/(α+β)`. Effective confidence computed at query time (δ), never at write time; stored
  confidence is immutable history.
- **SL bridge** (§2.5) under §0.3 convention (`α=r+a·W`, `β=s+(1−a)·W`; defaults `W=2, a=0.5`,
  corpus-overridable): `belief=(α−a·W)/(α+β)`, `disbelief=(β−(1−a)·W)/(α+β)`,
  `uncertainty=W/(α+β)`, `projected=α/(α+β)`.
  **Pinned test:** `Beta(1,1)` → belief 0, disbelief 0, uncertainty 1, projected 0.5.
- **Convention propagation (Appendix D discipline):** every α,β-dependent formula in MVP
  (effective mean, SL bridge, the `scalar_to_beta` used by `beta_from_raw`) is implemented
  under the pinned convention and tested against its worked example.

---

## 6. Distribution protocol (MVP subset, §5.1–5.2)

Full `DistributionProtocol<T>` interface. Beta (`T = {alpha, beta}`) and scalar (`T = number`)
bindings implement:

- `serialize` / `deserialize` / `canonicalize` (stable bytes for hashing).
- `mean`, `variance`.
- `to_subjective_logic_opinion` / `from_subjective_logic_opinion` (Beta only; scalar absent
  without an explicit pseudocount — never silently fabricated).

`combine` / `supported_rules` / `is_idempotent` declare **no combination rules in MVP**:
`supported_rules() → ∅`, `combine() → typed error`. This keeps the interface complete and
forward-compatible; v1 fills in the five rules and the idempotence contract (§11).

---

## 7. Write pipeline — immediate-promote (§7.1–7.3, 7.7)

Promotion steps (§7.1):

1. Compute `scopeHash`, `valueHash`.
2. Source-weight raw confidence → form Beta parameters (`beta_from_raw`, see flag below).
3. Validate against schema: required fields, key pattern, **strict scope**, value type.
4. Cheap contradiction check (§7.3).
5. Assign `id` (UUID), `recorded` (monotonic), `status`.
6. Commit to storage.

- **`recorded` monotonicity** (§2.6): a per-commit sequence counter is the tiebreaker for
  equal logical timestamps.
- **Cheap contradiction check** (§7.3): match `(subject, key, scopeHash)` **filtered to
  `status = validated`** with a different `valueHash`. All four policies implemented:
  `always_accept`, `reject_on_contradiction` (fail if a higher-confidence validated claim with
  the triple and a different value exists), `accept_but_mark` (commit + write a contradiction
  artifact claim), `accept_and_resolve(rule)` (apply `deprecate_lower` / `keep_newer` at commit).
- **Idempotency** (§7.7): optional key scoped to `(corpus, writer, key)`; 24h window; durable in
  SQLite; duplicate returns the original result without reprocessing.

### ⚠️ Flagged spec-interpretation decision — `beta_from_raw`

§2.4 says raw confidence is "scaled by a per-source weight" at promotion; §3.2 gives the only
fully-specified formula `scalar_to_beta(scalar, pseudocount, a)` plus a per-source
`scalarPseudocount` map; Appendix A's weight column equals the §4.9 *combination* trust table.

**MVP interpretation (recorded for review):**
```
beta_from_raw(raw, source, schema):
  pseudocount = schema.scalarPseudocount[source]   # REQUIRED — no silent default (§3.2 MUST)
  if pseudocount is missing: throw at write time
  return scalar_to_beta(raw, pseudocount, a):
    α = raw · pseudocount + a·W
    β = (1 − raw) · pseudocount + (1 − a)·W
```
- The per-source `scalarPseudocount` **is** the promotion-time source weighting.
- Appendix A's numeric weights are treated as **combination-time trust weights**, deferred to
  v1 with ⊕ (`rule_weighted_avg`).
- Uses the only fully-specified formula; honors "no silent pseudocount default"; avoids the
  `raw × 1.3 > 1` problem from a literal "multiply the mean by the weight" reading.

> **Future (v1):** when ⊕ and the combination rules land, reconcile the Appendix-A weight
> against `rule_weighted_avg`'s trust weights and confirm this promotion-time interpretation
> still holds. Tracked in §11.

---

## 8. SQLite adapter (§10)

- `better-sqlite3`, WAL mode, single-writer (§10.1).
- One `claims` table: scalar columns (`id` PK, `profile`, `workspace`, `subject`, `key`,
  `scope_hash`, `value_hash`, `conf_distribution`, `conf_params`, `conf_raw`, `conf_effective`,
  `valid_from`, `valid_to`, `recorded`, `recorded_seq`, `status`, `source`, `schema_version`)
  + JSON1 columns (`scope_json`, `value_json`, `provenance_json`, `evidence_json`,
  `audience_json`, `tags_json`).
- **Non-unique** index on `(profile, key, scope_hash)` (NOT unique — `id` is the PK, §2.3);
  indexes on `subject`, `status`, `recorded`.
- Separate `idempotency` table: `(corpus, writer, key) → (result, created_at)`.
- `capabilities()` returns the §10.2 SQLite row — every `PredicateKind` is `native_unindexed`.
- Interface (§10): `insertClaim`, `getClaim`, `deleteClaim` (soft = deprecation),
  `insertBatch`, `query(plan)`, `ensureIndex`, `dropIndex`, `beginTransaction`/`commit`/
  `rollback` (implemented even though MVP writes are single-commit), `capabilities`.
  `subscribeChanges` returns no handle (push deferred to v1 subscriptions).

---

## 9. Composition κ (§4.12)

- **`φ_format`**: xml, markdown, json, plain text (each small; all four implemented).
- **`β_budget`**: truncate to a token budget keeping highest-ranked content. Pluggable
  token counter; default heuristic estimator `ceil(chars / 4)`. (Real tokenizer swappable
  later — §12.)
- **`δ_dedup_content`**: remove near-duplicates via a Jaccard content-similarity threshold.
- **`κ`** = `β_budget ∘ φ_format ∘ δ_dedup_content`.
- `ComposedContext` is a terminal type — the algebra ends here.

---

## 10. Acceptance — reduced Worked Query 1

Seed a corpus, then evaluate:

```
τ_now(corpus("workspace:canopy"))
  → σ_subject="lineage-block"
  → δ_exponential(half_life=30d)
  → σ_status="validated" ∧ confidence>0.7
  → ρ_jaccard("lineage block schema considerations")
  → γ_2
  → κ_xml(12000 tokens)
→ ComposedContext
```

"Reduced" vs. full Worked Query 1 = (a) `ρ_cosine → ρ_jaccard` (non-embedding), and (b) the
read-time `⊥` / `resolve_deprecate_lower` steps dropped (deferred to v1). The end-to-end test
asserts the resulting `ComposedContext`: which claims survive each stage, ranking order,
evidence inclusion to depth 2, XML well-formedness, and budget truncation.

---

## 11. Deferred features (feature splits → target milestone)

Every capability the MVP deliberately omits, and where it lands. Nothing here is dropped — it
is sequenced.

| Capability | Spec | Target | Split note |
|---|---|---|---|
| `combine` / 5 combination rules / idempotence contract | §4.9, §5.6 | **v1** | MVP `DistributionProtocol` declares no rules; bindings stub `combine`. v1 implements `rule_weighted_avg`, `rule_evidence_pooled`, `rule_max_mean`, `rule_max_concentration`, `rule_dempster` (pinned test `Beta(3,2)⊕Beta(3,2)=Beta(5,3)`). |
| Belief combination ⊕ (`⊕_dedupe`, `⊕_synthesize_as`) | §4.9 | **v1** | Depends on combine rules above. |
| Read-time contradiction ⊥ pairs + n-way clusters + resolvers | §4.8 | **v1** | MVP keeps only the *write-time* cheap contradiction check (§7.3). Read-time ⊥ operator + `resolve_*` deferred. |
| Aggregation α family + Beta-typed rate + `α_join_aggregate` | §4.13 | **v1** | Pinned test `Wilson 22/30≈0.55 > 1/1≈0.21`. |
| Layered override ⊳, join ⋈ | §4.10–4.11 | **v1** | Need multi-corpus. |
| Multi-corpus catalog + per-reference access + `requiredTiers` for protocols | §3.1, §6.3 | **v1** | MVP is single core-only corpus; `requiredTiers={core}` validated. |
| Transactions, batch writes, derived writes + `ReplayStatus` | §7.4–7.6 | **v1** | MVP is immediate-promote single commit. Provenance is *recorded* in MVP but not replayed. |
| Subscriptions (triggers, delivery, backpressure, lifecycle, state) | §8 | **v1** | MVP adapter `subscribeChanges` returns no handle. |
| Access control / authorization adapter / row-level / audit corpus | §9 | **v1** | MVP has no auth enforcement. |
| Postgres adapter; embedding-backed `ρ_cosine` + embedding adapter | §10.1, §4.6 | **v1** | MVP is SQLite + Jaccard/exact. |
| `DistributionProtocol` Dirichlet binding + `resolve_synthesize_belief_multi` | §5.3 | **v2** | Pinned test `extend_to_frame → Dirichlet(3,1.2,0.8)`. |
| `DistributionProtocol` Gaussian / Kalman binding + bimodal warning | §5.4 | **v2** | |
| Mixed-distribution combination + `extend_to_frame` | §5.5 | **v2** | |
| Full value-predicate adapter matrix (DuckDB, vector, markdown vault) | §10 | **v2** | MVP implements only the SQLite row. |
| Erasure profile `[Prof]` | Appendix H | **v2 (customer-gated)** | Built only when a trigger condition (Appendix H.4) fires. Prerequisite provenance discipline (input hashing, model-version pinning, evaluationClock) is banked from v1 derived writes. |

---

## 12. MVP shortcuts & required future optimizations

Deliberate MVP simplifications that work correctly but will need revisiting. Distinct from
§11 (omitted features); these are *present-but-simplified*.

| Shortcut | Why acceptable for MVP | Future work |
|---|---|---|
| In-memory operator evaluation (load at leaf, transform in RAM) | Optimizer never required for correctness (§4.14); SQLite value predicates are `native_unindexed` anyway | **v1+**: predicate push-down, streaming/iterator evaluation for large corpora, per-(adapter, predicate-kind) execution-strategy selection (§10.2). |
| No query optimizer | Correctness-independent (§4.14) | **v3 (per Appendix G.1)**: cost models, plan-equivalence detection, push-down/hoist rewrites from the §4.14 law set. |
| Heuristic token counter (`chars/4`) in `β_budget` | Adequate for budget truncation in tests | **v1+**: pluggable real tokenizer (e.g. tiktoken) per target model. |
| Catalog held in memory (config-provided) | Single corpus; claims persist in SQLite | **v1+**: persist catalog (corpus defs, schemas, versions) to storage; schema-migration tooling (deferred to v3, Appendix G.1). |
| `provenance` recorded but not replayed | No derived writes in MVP | **v1**: replay verification + `ReplayStatus` stratification (§7.6); mandatory version provenance on derived writes. |
| Single-writer, single-commit writes | SQLite is single-writer (§10.1) | **v1**: transactions/batch (§7.4–7.5); Postgres MVCC multi-writer; **v3**: distributed multi-writer (Appendix G.1). |
| Leaf loads whole corpus (optional trivial push-down only) | MVP-scale corpora | **v1+**: bounded fetch + push-down of indexed equality/range/temporal filters. |
| `beta_from_raw` interpretation (pseudocount = source weighting) | Uses the only fully-specified formula; ⊕ out of scope | **v1**: reconcile Appendix-A weight vs. `rule_weighted_avg` trust weights when combination lands (§7 flag). |

---

## 13. Test strategy (TDD, spec-anchored)

Every operator and rule gets tests pinned to the spec's worked numeric examples, MVP subset:

- SL bridge: `Beta(1,1)` → belief 0, uncertainty 1, projected 0.5; effective mean `Beta(3,2)→0.6`.
- Scope: empty → `"_"`; structural/canonical equality; sorted-key hash stability.
- Key/subject: subject = first segment; reject dynamic-segment keys.
- σ value predicates: parse-time type-check rejects unknown field / type mismatch / bad enum;
  runtime mismatch → typed error, never silent empty.
- τ: `τ_known(T) = τ_valid(T) ∘ τ_recorded(T)`; `τ_recorded(past)` stable.
- δ: `δ_exponential` half-life math; `δ_none` identity; stored confidence unchanged (effective only).
- ρ: Jaccard scoring; `sim_exact` 1/0; registry + `defaultSimilarityFn` selection.
- γ: bounded depth; DAG, no duplication; write-time acyclicity enforcement (reject self-citation/cycle).
- κ: XML well-formedness; `β_budget` keeps highest-ranked under budget; `δ_dedup_content` threshold.
- Write: scopeHash/valueHash; status/recorded assignment; recorded monotonicity;
  no-silent-pseudocount-default throws; the four contradiction policies; idempotency window.
- Catalog: `requiredTiers` startup rejection of a protocol/profile corpus when only core is available.
- **Acceptance:** seed + reduced Worked Query 1 → asserted `ComposedContext`.

---

## 14. Public API sketch

```ts
const mneme = createMneme({ adapter, availableTiers: ["core"] });

mneme.createCorpus(definition);                                  // §6.1
mneme.commit(corpusId, candidate, { policy, idempotencyKey });   // immediate-promote, §7.1
const ctx = await mneme.query(corpusId, expr);                   // evaluate algebra, §4

// expr built with a typed builder mirroring the algebra:
//   pipe(corpus("workspace:canopy"),
//        tau.now(), sigma({ subject: "lineage-block" }),
//        delta.exponential({ halfLifeDays: 30 }),
//        sigma({ status: "validated", confidenceGt: 0.7 }),
//        rho.jaccard("lineage block schema considerations"),
//        gamma(2), kappa.xml({ tokenBudget: 12000 }))
```

---

## 15. Next step

Author the MVP DAG plan with **parallel-dag-execution:writing-dag-plans** (library code is
genuinely multi-file and parallelizable). This overrides the brainstorming skill's default of
`superpowers:writing-plans`, per the project's top-level instruction. v1 and v2 each get their
own brainstorm → DAG plan → execute cycle when their turn comes.
