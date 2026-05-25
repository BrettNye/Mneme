# Mneme — A typed algebra for AI-memory retrieval

**Version:** 0.1 (draft)
**Status:** Specification in progress. Constrained by five worked queries; gaps flagged.

---

## 1. Motivation and reframe

### 1.1 What this is

Mneme is a typed algebra and library specification for AI-memory retrieval. It defines a set of composable operators over a corpus of typed claims, plus a write and subscription model, plus a catalog model for naming and organizing corpora. The library implements the algebra over pluggable storage backends; it does not ship its own storage engine.

### 1.2 The problem this is solving

Current options for AI-memory retrieval fall into three categories, all of which are wrong for what AI memory actually needs:

Opinionated memory products (Mem0, Letta, Zep, Honcho) bake a theory of memory into the product. They work if your use case fits the embedded theory, and break otherwise. The theory itself is usually biologically inspired and carries assumptions that don't apply to stateless transformers.

Vector databases (Pinecone, Weaviate, Chroma, Qdrant) treat retrieval as semantic-similarity-with-metadata-filtering. That is one retrieval mode among many that AI memory needs. Confidence-weighted ranking, recency decay, structured-key lookups, temporal walks, contradiction-aware retrieval, persona-scoped slicing, outcome-correlated reweighting, and provenance traversal are all first-class needs that vector DBs handle awkwardly or not at all.

Structured databases (Postgres, SQLite, DuckDB) are powerful at queries but treat data as plain rows. They have no native primitives for the AI-specific dimensions — confidence, decay, provenance chains, contradiction detection, semantic similarity, bitemporal validity, persona scoping. Every application reimplements these in app code, often inconsistently.

The gap: no library treats *the access patterns of AI-memory retrieval* as the primary design surface. Mneme does.

### 1.3 The math-not-biology framing

Mneme is designed around the actual mathematics of LLM-based systems, not around biological metaphors of memory.

LLMs are deterministic functions from context to logits. They have no internal state between calls. Memory cannot live "inside" the model. What humans call "agent memory" is, mechanically, *additional input to a stateless function* — assembled at call time by an orchestration pipeline.

Under this framing:

- The "agent" is not a unit of cognition. It is the composition of (LLM function, prompt construction logic, retrieval logic, output processing). Memory belongs to the composition, not to the LLM.
- "Remembering" is not internal recall. It is *input curation* — selecting which past data becomes part of the current input.
- "Learning" is not weight updates. It is *changes to how curation happens over time*, driven by outcome data.
- "Identity" is not a persistent self. It is *the consistency of the prompt template and retrieval policy* across invocations.

This reframe has architectural consequences:

- Memory is a database problem, not a cognition problem. Query design, indexing, schema, retrieval ranking — all problems with mature engineering answers.
- The corpus of facts is the differentiated asset. The LLM is interchangeable; the corpus is not.
- Determinism is a feature, not a problem. Same corpus state, same retrieval policy, same input produces the same output. Audit-grade provenance is the natural state, not an aspiration.
- The corpus structure is reverse-engineered from query access patterns, not from a theory of mind.

Mneme commits to this framing throughout. Every operator and every named entity in the spec is defined in terms of *claims, scopes, tags, retrieval policies, and outcome correlation* — never in terms of "agents," "memories," or "preferences" as entities. Biological vocabulary is acceptable in user-facing documentation; it is forbidden in the spec.

### 1.4 What Mneme is and is not

Mneme is:

- A typed algebra of operators over a corpus of typed claims.
- A library implementation of that algebra over pluggable storage backends.
- A catalog model for naming, organizing, and access-controlling corpora.
- A write model with two-phase commits, contradiction policies, and derived-write provenance.
- A subscription model for reactive evaluation of long-running queries.

Mneme is not:

- A storage engine. It adapts existing engines (SQLite, Postgres, DuckDB, vector DBs).
- A hosted database product. The library is the artifact; hosted offerings are downstream.
- An AI agent framework. It is the substrate over which such frameworks compose retrieval.
- An LLM. It does not call LLMs; it produces the inputs that consumers feed to LLMs.

---

## 2. Core types

### 2.1 Claim

A claim is a typed tuple representing one assertion in the corpus.

```
Claim {
  id           : UUID                              -- unique identifier, assigned on promotion
  profile      : ProfileId                         -- isolation scope (tenant boundary)
  workspace    : WorkspaceId                       -- workspace scope within profile
  subject      : Subject                           -- top-level namespace (user, repo, persona, …)
  key          : Key                               -- structured static identifier
  scope        : Scope                             -- dynamic context (workflowName, entityId, …)
  value        : Value                             -- the asserted content
  confidence   : Confidence                        -- belief distribution (see §2.4)
  valid        : Interval                          -- valid-time interval [from, to)
  recorded     : Instant                           -- transaction-time when committed
  status       : Status                            -- candidate | provisional | validated | deprecated
  source       : Source                            -- manual | verification | workflow | heuristic | llm | imported
  provenance   : Provenance                        -- run/node/persona that produced this
  evidence     : Set<EvidenceRef>                  -- pointers to supporting sources
  audience     : Audience                          -- persona-targeting hints
  tags         : Set<Tag>                          -- lightweight categorical hints
  schema       : SchemaVersion                     -- version of the claim type schema
}
```

Critical commitments:

**Confidence is a distribution, not a number.** See §2.4. A claim does not say "0.8 confidence" as a point estimate; it carries enough information to compute an effective confidence under a chosen policy.

**Time is bitemporal.** Every claim has both a *valid-time interval* (when the claim's content was true about the world) and a *recorded instant* (when the claim entered the corpus). These are distinct dimensions and the algebra treats them separately.

**Scope is dynamic context.** The (subject, key) pair is the *static* identity of what the claim is about; scope qualifies that with the *dynamic* situation in which the claim applies. Workflow names, entity IDs, run IDs, persona IDs go in scope. Two claims with the same (subject, key) but different scopes are distinct facts, not duplicates.

**Status is a lifecycle, not a quality measure.** Confidence measures quality. Status indicates where in the validation pipeline the claim sits.

### 2.2 Subject and Key

**Subject** is a top-level namespace string. Examples: `user`, `repo`, `workflow`, `team`, `entity`, `global`. The subject is derived from the key prefix; it is never authored independently. Validators enforce that `subject` matches the first segment of `key`.

**Key** is a kebab-case dotted identifier. Format: `{subject}.{domain}[.{property}]`. Keys are static — dynamic context goes in scope, not the key. Examples: `repo.test-command`, `user.preference.terseness`, `workflow.architecture-review.consensus-level`.

Keys MUST be static. A key like `repo.{repoId}.test-command` is invalid — the repo ID belongs in `scope.repoId`, not in the key. This is the most common authoring mistake and validators MUST reject it.

### 2.3 Scope

Scope is a typed record of dynamic-context fields. Standard fields include:

```
Scope {
  workflowName? : string
  runId?        : string
  teamId?       : string
  personaId?    : string
  entityType?   : string
  entityId?     : string
  topic?        : string
  modelId?      : string
  ...custom-fields per workspace
}
```

Scope is *strict* — unknown fields are rejected at write time. Custom fields are declared in the workspace's claim schema. This prevents scope drift (the same logical context being represented with different field names by different writers).

Scope equality is structural and canonical. Two scopes are equal iff they have the same set of fields with the same values, after canonicalization (sorted keys, omitted undefined values, normalized strings). The library computes a `scopeHash` (SHA-256, 16-char prefix) over the canonical form, which serves as part of the claim's storage key.

### 2.4 Confidence

Confidence is a distribution, represented by a parameterized type. The default implementation uses a Beta(α, β) distribution parameterized by positive and negative evidence weights, but the algebra is generic over the distribution type.

```
Confidence {
  distribution : DistributionType                  -- "beta", "scalar", "dirichlet", "custom"
  parameters   : DistributionParameters            -- e.g., {alpha: 8.2, beta: 1.4}
  raw          : Number                            -- raw 0..1 from source (pre-weighting)
  effective    : Number?                           -- cached point estimate (computed)
}
```

A scalar confidence (point estimate only) is supported via `distribution = "scalar"`. This makes Mneme compatible with simple confidence models while allowing richer distributions for systems that need them.

**Effective confidence is computed at query time, not at write time.** The stored confidence reflects the raw value and the source-weighted parameters; decay and other adjustments are applied during query evaluation via the δ operator. This means stored confidence is *immutable history*; perceived confidence is *computed*.

**Source weighting** is applied at promotion time (see §6.2). Default weights:

| Source        | Weight | Notes                                    |
|---------------|--------|------------------------------------------|
| manual        | 1.3    | Explicit user input, highest trust       |
| verification  | 1.2    | Verified from test/build results         |
| workflow      | 1.0    | Standard workflow output                 |
| heuristic     | 0.9    | Deterministic extraction rules           |
| llm           | 0.7    | LLM inference                            |
| imported      | 0.6    | External sources, lowest trust           |

These are defaults; corpora MAY override per their schema.

### 2.5 Time

**Valid-time interval** is `[from, to)` where `from` and `to` are `Instant` values (ms since epoch). `to` may be `∞` for claims with no end time. Open intervals are used throughout: `[a, b)` includes `a` and excludes `b`.

**Recorded** is an `Instant` representing transaction time — when the claim was committed to the corpus. The library assigns this at commit time; writers do not specify it.

The library MUST guarantee that `recorded` is monotonically non-decreasing across the global commit order. If two commits occur with the same logical timestamp (e.g., in a batch), they are totally ordered by an additional tiebreaker (a per-commit sequence number).

### 2.6 Provenance

Provenance records where the claim came from.

```
Provenance {
  workflow?     : string                           -- workflow definition name
  runId?        : string                           -- specific run that produced this
  nodeId?       : string                           -- node within the workflow
  persona?      : string                           -- persona that produced this
  artifactId?   : string                           -- specific artifact reference
  derivedFrom?  : DerivationProvenance             -- if this is a derived claim (see §6.5)
}

DerivationProvenance {
  queryExpression : SerializedAlgebraExpression    -- the query that produced this
  corpusState     : LogicalTimestamp               -- corpus state at evaluation
  combinationRule : string                         -- rule used (if synthesis)
  inputClaims     : Set<ClaimId>                   -- contributing claims
}
```

Derivation provenance makes derived claims *reproducible*. Any consumer can re-run the serialized query against the recorded corpus state and verify they get the same derived claim. This is the audit-grade-provenance guarantee.

### 2.7 EvidenceRef

Evidence references point to supporting data.

```
EvidenceRef =
  | ClaimRef { claimId: UUID }                     -- another claim in the corpus
  | DocumentRef {
      sourceDocumentId : string                    -- workspace source document
      offsetStart      : Number?                   -- character offset (inclusive)
      offsetEnd        : Number?                   -- character offset (exclusive)
      extractionMethod : ExtractionMethod          -- heuristic | llm | pattern | manual
    }
  | ExternalRef { uri: URI, contentHash?: string } -- external resource
```

Evidence forms a directed acyclic graph over claims. Cycles are forbidden — a claim cannot transitively cite itself. The library MUST enforce this at write time.

---

## 3. Catalog model

### 3.1 Corpora as named entities

A **corpus** is a named, schema-bound, access-controlled collection of claims. The library manages a catalog of corpora. Queries reference corpora by name.

```
Corpus {
  id          : CorpusId                           -- stable identifier (kebab-case)
  displayName : string                             -- human-readable
  schema      : ClaimSchema                        -- type definition (see §3.2)
  policy      : AccessPolicy                       -- read/write authorization (see §3.4)
  defaults    : CorpusDefaults                     -- default behaviors (see §3.3)
  storage     : StorageAdapterRef                  -- which adapter backs this corpus
  metadata    : Record<string, any>                -- arbitrary tags
  createdAt   : Instant
  updatedAt   : Instant
}
```

Corpora are first-class. The previous design treated "the corpus" as a single global entity; this is wrong. Real deployments have multiple corpora with different schemas, policies, and storage backends, accessed in the same query.

Standard corpus identifiers follow `{kind}:{name}` convention:
- `wiki:nestjs-general` — a wiki-style knowledge collection
- `persona:backend` — a persona-scoped claim collection
- `workspace:crewtracks-modules` — workspace-scoped claims
- `audit:run-events` — append-only event log

The prefix is convention, not enforced. The library treats corpus IDs as opaque strings; the prefix is a documentation aid.

### 3.2 Claim schema

A claim schema declares the types and constraints for claims in a corpus.

```
ClaimSchema {
  version       : SchemaVersion                    -- e.g., "1.0.0"
  subjects      : Set<Subject>                     -- allowed subjects in this corpus
  keys          : Map<Subject, KeyPattern>         -- allowed keys per subject
  scopeFields   : Map<string, FieldType>           -- declared scope fields and types
  valueSchemas  : Map<Key, ValueSchema>            -- value type per key (optional)
  required      : Set<FieldName>                   -- which top-level fields are required
  similarities  : Map<ValueTypeId, SimilarityFn>   -- registered similarity functions
}
```

Schemas declare what *can* exist in the corpus. Writes that don't conform are rejected. Queries reference field names that must exist in the schema; missing fields are a query-time error, not a silent empty result.

Schema versions are tracked per claim — the `Claim.schema` field records the version under which the claim was written. The catalog tracks active schema versions and migration paths.

### 3.3 Corpus defaults

Per-corpus default behaviors that queries inherit unless overridden.

```
CorpusDefaults {
  decayPolicy           : DecayPolicy              -- default decay rule
  confidenceThreshold   : Number                   -- default confidence floor for queries
  contradictionPolicy   : ContradictionPolicy      -- default write-time policy
  retentionPolicy       : RetentionPolicy          -- when claims are physically removed
  defaultSimilarityFn   : SimilarityFn             -- default for ρ when not specified
  defaultStatus         : Set<Status>              -- default status filter for queries
}
```

These are *defaults*. Individual queries can override any of them. The point is to factor common settings out of query expressions — without defaults, every query would have to redeclare its decay policy, confidence threshold, and contradiction policy.

### 3.4 Access policy

Access policies declare who can read, write, subscribe to, and administer a corpus.

```
AccessPolicy {
  reads      : Set<PrincipalPattern>               -- who can read
  writes     : Set<PrincipalPattern>               -- who can write
  subscribes : Set<PrincipalPattern>               -- who can subscribe
  admin      : Set<PrincipalPattern>               -- who can modify policy/schema
  conditions : Set<ConditionalRule>                -- conditional access (per claim, per scope)
}
```

PrincipalPatterns are pluggable — they integrate with Bedrock (or any other authorization engine) via an authorization protocol (see §8). The library does not implement RBAC internally; it delegates to the authorization adapter.

The library MUST enforce access policy at every read, write, and subscribe operation. Access denials are themselves auditable events that write to a designated audit corpus.

---

## 4. The query algebra

### 4.1 Type signature notation

Each operator is presented with a type signature, an intuition, and an equational law section.

`Corpus` denotes a typed collection of claims. `RankedCorpus` is a corpus where each claim has an associated score (typically a similarity score). `ComposedContext` is a token-budgeted, formatted document ready for LLM input.

`σ` (sigma) = selection. `π` (pi) = projection. `⋈` = join. `τ` (tau) = temporal slicing. `δ` (delta) = decay. `ρ` (rho) = similarity ranking. `γ` (gamma) = provenance traversal. `⊥` (bottom) = contradiction detection. `⊕` (oplus) = belief combination. `⊳` (rhd) = layered override. `κ` (kappa) = composition.

### 4.2 Selection — σ

```
σ_p : Corpus → Corpus
```

Filter the corpus to claims matching predicate `p`. The predicate language is composable and includes:

- **Relational predicates**: `key = X`, `subject ∈ S`, `scope.entityId = Y`
- **Probabilistic predicates**: `confidence > 0.7` (evaluated using a configurable point estimator over the distribution)
- **Temporal predicates**: `valid-at(D)`, `recorded-after(T)` (see also §4.4)
- **Tag predicates**: `tag ∈ T`, `tag ⊇ S` (set containment)
- **Status predicates**: `status = validated`, `status ∈ {validated, provisional}`
- **Compound predicates**: `p₁ ∧ p₂`, `p₁ ∨ p₂`, `¬p`

Predicates compose via boolean operators. The selection operator is the workhorse of the algebra; most queries are mostly selection.

**Equational laws**:
- Commutativity: `σ_p₁(σ_p₂(C)) = σ_p₂(σ_p₁(C))`
- Conjunction split: `σ_{p₁ ∧ p₂}(C) = σ_p₁(σ_p₂(C))`
- Push-down through other operators: see §4.13

**Incremental evaluation**: Streamable. For a new write, check whether the new claim matches `p`; if so, add to result; if a deletion (deprecation), remove if previously matched.

### 4.3 Projection — π

```
π_f : Corpus → Corpus
```

Restrict each claim to the subset of fields specified by `f`. The result is still a corpus, but with thinner claims (some fields elided).

Used primarily for token efficiency in composition — when the consumer doesn't need full claims, projection reduces the data flowing through the rest of the pipeline.

**Equational laws**:
- Idempotence: `π_f(π_f(C)) = π_f(C)`
- Composition: `π_f(π_g(C)) = π_{f ∩ g}(C)` (when `f ⊆ g`)

**Incremental evaluation**: Streamable.

### 4.4 Temporal slicing — τ

Three variants, one for each bitemporal question.

```
τ_valid(T)     : Corpus → Corpus
τ_recorded(T)  : Corpus → Corpus
τ_known(T)     : Corpus → Corpus
```

**`τ_valid(T)`** — restrict to claims whose valid-time interval covers T. Answers "what was true about the world at T."

**`τ_recorded(T)`** — restrict to claims with `recorded ≤ T`. Answers "what had been written to the corpus by T."

**`τ_known(T)`** — restrict to claims where both `valid-time covers T` *and* `recorded ≤ T`. Answers "what would the system have computed if asked at T about T."

`τ_now` is shorthand for `τ_known(currentInstant())`.

Most queries against the present should use `τ_now`. Time-traveling queries should use `τ_known(T)` for the standard "what did we know then" question. The other variants are for specialized needs (auditing historical writes, revising retrospective views as late-arriving claims arrive).

**Equational laws**:
- `τ_valid(T)` and `σ_p` commute when `p` doesn't reference time
- `τ_recorded(T)` and `σ_p` commute when `p` doesn't reference recorded-time
- `τ_known(T) = τ_valid(T) ∘ τ_recorded(T)` (composition of the two)

**Incremental evaluation**: For `τ_recorded(T)` with `T ≤ now`, the result is stable — no new writes can be `recorded` at or before a past T. For `τ_now`, the result evolves; the library re-evaluates incrementally on each commit.

### 4.5 Decay — δ

```
δ_policy : Corpus → Corpus
```

Apply time-based confidence adjustment per `policy`. The decay policy is a function from `(recorded, current, source)` to a confidence multiplier in `[0, 1]`.

Standard policies:
- `δ_none` — no decay; identity transformation
- `δ_exponential(half_life)` — exponential decay with given half-life
- `δ_linear(rate)` — linear decay at `rate` per day
- `δ_step(threshold)` — full confidence until threshold age, zero after

Decay does NOT mutate the underlying confidence. It produces a new corpus where each claim's *effective confidence* reflects the decay. Subsequent operators that reference confidence (e.g., `σ_{confidence > 0.7}`) see the effective values.

**Equational laws**:
- `δ_pol(σ_p(C)) = σ_p(δ_pol(C))` when `p` does not reference confidence
- `δ_pol₁(δ_pol₂(C))` is generally NOT equal to `δ_{pol₁ ∘ pol₂}(C)` — decay is not freely composable

**Incremental evaluation**: Streamable. Each new claim has decay applied based on its own recorded-time and the current time.

### 4.6 Similarity ranking — ρ

```
ρ_sim, q : Corpus → RankedCorpus
```

Score each claim by similarity to query value `q` using similarity function `sim`. The output is the input corpus annotated with similarity scores per claim.

Similarity functions are pluggable via a protocol:

```
SimilarityFn {
  scoreOne(claim: Claim, query: Value) → Number  -- 0..1 similarity
  scoreBatch(claims: Set<Claim>, query: Value) → Map<ClaimId, Number>
  isPure : Bool                                    -- deterministic given same inputs?
  cost   : CostHint                                -- O(1), O(log n), O(n), …
}
```

Standard similarity functions:
- `sim_cosine` — vector cosine over embeddings (requires embedding adapter)
- `sim_jaccard` — Jaccard over token sets
- `sim_bm25` — BM25 over text content
- `sim_exact` — exact match (returns 1.0 or 0.0)
- `sim_structural` — domain-specific structural matching (for typed value schemas)

**Equational laws**:
- Monotonicity: `ρ_sim,q(σ_p(C))` produces a subset of the rankings of `ρ_sim,q(C)` (filtering before ranking gives a subset of the ranking after filtering)
- Idempotence: `ρ_sim,q(ρ_sim,q(C))` is well-defined but typically redundant; the second application is a no-op if scores are stored

**Incremental evaluation**: Not streamable in the general case. A new claim might score higher than the current top-K and change the ranking. For small K, the library can maintain a sorted structure efficiently; for large K, full re-ranking is expensive. Subscriptions over ρ should be used with caution.

### 4.7 Provenance traversal — γ

```
γ_d : Corpus → Corpus
```

For each claim in the input corpus, follow evidence edges to depth `d`, returning the transitive closure of cited claims. `γ_0(C) = C`. `γ_1(C)` includes C plus all directly-cited claims. `γ_∞(C)` includes the full provenance graph reachable from C.

The result is a corpus containing both the original claims and their evidence-graph ancestors, with no duplication.

**Equational laws**:
- Monotonicity: `C ⊆ γ_d(C)` for all `d ≥ 0`
- `γ_{d₁}(γ_{d₂}(C)) = γ_{d₁ + d₂}(C)` (composition)

**Incremental evaluation**: Streamable for bounded `d` if the evidence graph index is maintained. Unbounded depth (`d = ∞`) is generally expensive to maintain incrementally and should use lazy evaluation.

### 4.8 Contradiction detection — ⊥

```
⊥ : Corpus → Set<ContradictionPair>
```

Find claim pairs that conflict. Two claims conflict iff:
1. They share `(subject, key, scope)`
2. They have different `value`s
3. Both are above the corpus's contradiction confidence threshold

The output is the set of pairs, NOT a corpus — contradictions are meta-relations over the corpus.

```
ContradictionPair {
  left           : Claim
  right          : Claim
  conflictReason : ConflictReason                  -- value-difference, status-conflict, …
  resolution     : Resolution?                     -- if a resolution policy was applied
}
```

Resolution operators consume the pair set and produce a new corpus state:

```
resolve_deprecate_lower : Set<ContradictionPair> × Corpus → Corpus
resolve_flag_for_review : Set<ContradictionPair> × Corpus → Corpus
resolve_keep_both       : Set<ContradictionPair> × Corpus → Corpus
```

**Equational laws**:
- `⊥(σ_p(C)) ⊆ ⊥(C)` — filtering may remove contradiction pairs but cannot create new ones

**Incremental evaluation**: Streamable. A new claim may introduce contradictions with existing claims; check by scoping the contradiction search to claims sharing the new claim's `(subject, key, scope)`.

### 4.9 Belief combination — ⊕

Two distinct operators that the v0 algebra previously conflated.

```
⊕_dedupe : Corpus → Corpus
⊕_synthesize_as<S, K> : Corpus → Claim
```

**`⊕_dedupe`** — combine claims sharing `(subject, key, scope)` into a single claim using the configured combination rule. The result is a corpus with no within-key duplicates.

**`⊕_synthesize_as<S, K>`** — combine ALL claims in the input corpus into a single new synthesized claim with subject `S` and key `K`. The synthesized claim's evidence is the union of input evidence; its confidence is computed by the combination rule; its scope is derived from the inputs' shared scope fields.

Combination rules (parameterizable):

- `rule_dempster` — Dempster's combination rule (orthogonal evidence)
- `rule_weighted_average` — confidence-weighted by source trust
- `rule_max_confidence` — highest-confidence value wins
- `rule_evidence_pooled` — sum the underlying Beta parameters

**Equational laws**:
- `⊕_dedupe` is associative for symmetric rules (weighted_average, evidence_pooled)
- `⊕_dedupe` is NOT generally idempotent — repeated application may change confidence depending on the rule's semantics
- `⊕_synthesize_as` has no idempotence — it's a single-shot synthesis

**Incremental evaluation**: `⊕_dedupe` is streamable (new claim either merges with existing or stands alone). `⊕_synthesize_as` is streamable for monotonic combination rules and non-streamable for others (Dempster, in particular, can have order-dependent results in edge cases).

### 4.10 Layered override — ⊳

```
⊳ : Corpus × Corpus → Corpus
```

`C₁ ⊳ C₂` produces a corpus where C₁'s claims take precedence over C₂'s on matching `(subject, key, scope)` triples, but C₂ contributes claims about triples C₁ doesn't address.

This is the layered-merge semantic. Think of it as typed object-spread: `{...defaults, ...specifics}` where keys from `specifics` win.

For the operator to be well-defined, both inputs must be coherent (no within-input contradictions on the same triple). Callers SHOULD apply `⊕_dedupe` to each input before composing with ⊳.

**Equational laws**:
- Associativity: `(C₁ ⊳ C₂) ⊳ C₃ = C₁ ⊳ (C₂ ⊳ C₃)`
- Identity: `C ⊳ ∅ = C` and `∅ ⊳ C = C`
- NOT commutative: `C₁ ⊳ C₂ ≠ C₂ ⊳ C₁` in general

**Incremental evaluation**: Streamable when inputs are stable; the dominator's writes immediately override; the dominated's writes are admitted only when no matching triple exists in the dominator.

### 4.11 Join — ⋈

```
⋈_r : Corpus × Corpus → Corpus
```

Combine claims from two corpora via relation `r`. Specialized variants:

- `⋈_scope` — claims about the same scope-entity (join on `scope.entityId`)
- `⋈_evidence` — claims linked through evidence references
- `⋈_subject` — claims about the same subject

General relational joins are supported but rarely used in practice — most queries use the specialized variants.

**Equational laws**:
- Commutativity: `C₁ ⋈_r C₂ = C₂ ⋈_r C₁` for symmetric r
- Associativity: `(C₁ ⋈_r C₂) ⋈_r C₃ = C₁ ⋈_r (C₂ ⋈_r C₃)` for symmetric r
- Selection push-down: `σ_p(C₁ ⋈_r C₂) = σ_p(C₁) ⋈_r C₂` when `p` only references C₁'s fields

**Incremental evaluation**: Streamable for indexed joins; expensive for arbitrary relations.

### 4.12 Composition — κ (and its component operators)

The composition operator is split into three component operators that compose, plus a convenience operator for the common case.

```
δ_dedup_content   : RankedCorpus → RankedCorpus
φ_format          : RankedCorpus → ComposedContext  (parameterized by format)
β_budget          : ComposedContext × TokenBudget → ComposedContext
κ                 : RankedCorpus × Format × TokenBudget → ComposedContext  (convenience)
```

**`δ_dedup_content`** — remove near-duplicate content from a ranked corpus using a content-similarity threshold (Jaccard, cosine, etc.).

**`φ_format`** — produce a formatted document from a ranked corpus. Supported formats: XML, Markdown, JSON, plain text.

**`β_budget`** — truncate a composed document to a token budget, keeping highest-ranked content.

**`κ`** — convenience composition that applies dedup, format, and budget in sequence. Equivalent to `β_budget(φ_format(δ_dedup_content(...)))`.

ComposedContext is *not* a corpus. It is a terminal type — the algebra ends when composition produces it. Composition is a lossy, ordered, formatted output ready for an LLM context window.

**Equational laws**:
- Composition: `κ ≡ β_budget ∘ φ_format ∘ δ_dedup_content` (up to parameterization)
- NOT streamable — composition is order-sensitive and budget-sensitive in ways that fight incremental evaluation. Re-evaluation on each write is the safe semantics.

### 4.13 Optimizer-relevant laws

The algebra's equational laws enable a query optimizer. Key rewriting rules:

- **Push selection down**: filter as early as possible to reduce working sets
- **Push temporal slicing down**: time-slice before other operators when valid-time and recorded-time semantics permit
- **Push decay before confidence filters**: when a query filters by effective confidence, apply decay first
- **Hoist similarity to after selection**: filter the corpus before ranking to avoid expensive similarity computations on filtered-out claims
- **Combine adjacent projections**: `π_f ∘ π_g = π_{f ∩ g}`
- **Memoize stable subqueries**: subqueries against stable temporal slices (e.g., `τ_recorded(T)` for past T) can be cached

The optimizer is a separate component from the algebra — the algebra defines what's *legal*; the optimizer chooses among legal evaluation orders.

---

## 5. Catalog operations

### 5.1 Corpus management

```
createCorpus(definition: CorpusDefinition) → Corpus
updateCorpusSchema(id: CorpusId, schema: ClaimSchema, migration: Migration?) → Corpus
updateCorpusPolicy(id: CorpusId, policy: AccessPolicy) → Corpus
deleteCorpus(id: CorpusId, options: DeleteOptions) → DeletedCorpusReceipt
```

Corpus creation requires a schema and an access policy. Schema updates trigger validation against existing claims and may require a migration path (see §7.3). Deletion is irreversible and produces a receipt for audit purposes.

### 5.2 Discovery

```
listCorpora(filter: CorpusFilter?) → List<Corpus>
getCorpus(id: CorpusId) → Corpus
getCorpusSchema(id: CorpusId) → ClaimSchema
```

Discovery operations are read-only and respect access policy (corpora the caller cannot read are not returned).

### 5.3 Multi-corpus queries

Queries that span multiple corpora reference them by name in the query expression:

```
let general = σ_status=validated (corpus("wiki:nestjs-general"))
let project = σ_status=validated (corpus("wiki:crewtracks-modules"))
let layered = project ⊳ general
```

The library MUST enforce access policy on each corpus reference individually — the caller must have read access to every corpus referenced in a query.

Multi-corpus queries that combine corpora via ⊳, ⋈, or set operations produce a result corpus whose schema is the *union* (or intersection, for restrictive operations) of the input schemas. The library validates that combining operations are schema-compatible.

---

## 6. The write model

### 6.1 Write pipeline

Every write passes through a two-phase pipeline:

```
candidate emission → promotion → commit
```

**Candidate emission** — a writer submits a `CandidateClaim` to the library. The candidate is not yet visible to readers. It exists in a staging area.

**Promotion** — the library processes the candidate:
1. Compute deterministic hashes (`scopeHash`, `valueHash`)
2. Apply source weighting to raw confidence
3. Resolve scope fields against the corpus schema
4. Validate against schema (required fields, value types, key patterns)
5. Apply cheap contradiction checks (exact key+scope match)
6. Assign `id`, `recorded`, `status`

**Commit** — the promoted claim is written to storage. The corpus's logical timestamp advances. Subscribers are notified asynchronously.

Two modes are supported:
- **Immediate-promote** — emission, promotion, and commit happen in one call. The writer takes responsibility for full claim shape; the library does minimal processing.
- **Staged-promote** — candidates are explicitly emitted; promotion can be batched, deferred, or pipelined.

Most writers use immediate-promote. Staged-promote is for high-throughput ingestion (telemetry, observability) where batching saves cost.

### 6.2 Visibility guarantees

When a commit call returns successfully, the library guarantees:

- **Durability** — the claim is persisted to storage (fsync or equivalent). Survives library restart.
- **Read-your-writes within session** — the next snapshot query from the same session will see the new claim.
- **Recorded-time advance** — the corpus's logical timestamp has advanced past the new claim's `recorded` instant.

The library does NOT guarantee:

- **Synchronous subscription delivery** — subscribers are notified asynchronously, with at-least-once delivery semantics (see §7).
- **Cross-session immediate visibility** — concurrent readers from other sessions may briefly see the pre-write state (eventual consistency on the order of milliseconds).

A stronger guarantee — synchronous subscriber acknowledgment before commit returns — is available via opt-in flag (`commit(claim, wait_for_subscribers = true)`) but should be used sparingly because it ties writer latency to subscriber speed.

### 6.3 Contradiction policies

Each write specifies a contradiction policy. The library enforces the policy at promotion time.

```
ContradictionPolicy =
  | always_accept                                  -- commit regardless of conflicts
  | reject_on_contradiction                        -- error if higher-confidence claim conflicts
  | accept_but_mark                                -- commit and write a contradiction artifact
  | accept_and_resolve(rule: ResolutionRule)       -- apply resolution policy automatically
```

- **`always_accept`** — for telemetry, observations, audit events. No conflict checking.
- **`reject_on_contradiction`** — for authoritative records, formal specifications. Promotion fails if a higher-confidence claim with the same `(subject, key, scope)` exists.
- **`accept_but_mark`** — for operational knowledge, design rationale. Both claims live; a separate `contradiction` claim records the conflict for later review.
- **`accept_and_resolve(rule)`** — for cases where automatic conflict resolution is desired. The library applies the rule (e.g., `deprecate_lower`, `keep_newer`) at commit time.

Defaults are set per-corpus in `CorpusDefaults.contradictionPolicy` and can be overridden per write.

**Cheap vs. expensive contradiction checking**: At write time, the library performs *cheap* contradiction checks — exact match on `(subject, key, scope)` with different values. Expensive checks (semantic-similarity contradictions, multi-claim aggregate contradictions) are deferred to read-time via the ⊥ operator.

### 6.4 Transactions

Atomic batch commits are supported via the transaction primitive:

```
transaction {
  commit_candidate(claim_1)
  commit_candidate(claim_2)
  commit_derived(claim_3, query, corpusState)
  ...
} → TransactionResult
```

All writes in a transaction become visible atomically — either all succeed and the corpus advances once with all new claims, or the transaction rolls back and the corpus is unchanged.

**Interaction with subscriptions**: subscribers see a transaction as a single corpus-state advance, not as N separate events. A subscription with `trigger: on_every_match` will fire once per matching claim within the transaction, but the underlying corpus state advances only once.

**Interaction with contradiction policies**: within a transaction, contradictions are checked against the *post-transaction* state. Two writes within a transaction can contradict each other; resolution depends on the transaction's policy.

**Interaction with derived writes**: derived claims can reference earlier writes within the same transaction. The derivation provenance records the pre-transaction corpus state (the state the query saw); the derived claim is committed as part of the same transaction.

Transactions have bounded size. The library MAY reject transactions that exceed implementation-defined limits (e.g., 1000 writes per transaction). For larger batches, use the batch primitive (§6.5).

### 6.5 Batch writes

For non-atomic high-throughput writes:

```
commit_batch(claims: List<CandidateClaim>, policy: BatchPolicy) → BatchResult
```

Batch semantics:
- Writes are committed efficiently (single fsync, batched indexes)
- Claims may become visible incrementally as the batch processes
- Failures of individual writes do NOT roll back successful writes in the same batch
- Batch result includes per-write success/failure status

Use cases: telemetry ingestion, observability event streams, bulk import.

### 6.6 Derived writes

A derived write is a claim produced by a query expression, with the derivation recorded as provenance.

```
derive_claim_from(
  query           : AlgebraExpression,
  target_subject  : Subject,
  target_key      : Key,
  scope           : Scope,
  combination?    : CombinationRule
) → CandidateClaim

commit_derived(
  candidate       : CandidateClaim,
  provenance_query: SerializedAlgebraExpression,
  corpus_state    : LogicalTimestamp,
  policy?         : ContradictionPolicy
) → CommitResult
```

The derivation provenance records:
- The query expression that produced the claim (serialized)
- The corpus state at evaluation time
- The combination rule used (if synthesis)
- The set of input claim IDs that contributed

This makes the derived claim *deterministically reproducible*. Any consumer can re-run the query against the recorded corpus state and verify the result.

The library MUST preserve the corpus state at the time of derivation long enough for verification — typically until either an explicit retention policy expires or the derived claim is itself deprecated.

### 6.7 Idempotency

Every write supports an optional idempotency key:

```
commit(claim, idempotencyKey: string?) → CommitResult
```

If a write with the same idempotency key has been processed within the idempotency window (default: 24 hours), the library returns the original result without re-processing. This protects against retries during transient failures.

Idempotency keys are scoped to (corpus, writer-identity, key) — the same key from different writers does not collide.

---

## 7. The subscription model

### 7.1 Subscription primitive

```
subscribe(
  query     : AlgebraExpression,
  trigger   : TriggerSemantics,
  target    : DeliveryTarget,
  lifecycle : LifecyclePolicy
) → SubscriptionHandle
```

A subscription registers a long-running query and a notification target. When the corpus evolves in ways that match the trigger semantics, the library delivers notifications to the target.

### 7.2 Trigger semantics

```
TriggerSemantics =
  | on_every_match                                 -- fire on each new claim matching the query
  | on_transition(direction: Direction)            -- fire when result set crosses a boundary
  | on_every_write                                 -- fire on every corpus mutation regardless of match

Direction = to_nonempty | to_empty | either
```

**`on_every_match`** — for each newly-matching claim, fire one notification. Used for streaming insights, audit log forwarding, derived-write triggers.

**`on_transition(direction)`** — fire when the query's result transitions across an empty/nonempty boundary. Used for "alert when something starts happening" or "alert when something stops happening." Requires the library to maintain transition state.

**`on_every_write`** — fire on every commit, regardless of whether it matches the query. Used for comprehensive audit pipelines.

### 7.3 Streamable vs. non-streamable operators

Subscriptions over arbitrary query expressions may be expensive. The library classifies operators by incremental-evaluation cost:

**Streamable** (incremental cost O(1) or O(log n) per write):
- σ, π, τ, δ, ⊥, ⊳, ⊕_dedupe
- ⋈ on indexed fields
- γ for bounded depth

**Non-streamable** (require re-evaluation or have pathological worst-case):
- ρ (similarity ranking) — new claims may shift the top-K
- ⊕_synthesize_as — new claims may shift the synthesis
- κ, φ_format, β_budget — composition is order-sensitive

Subscriptions over query expressions containing non-streamable operators are allowed but emit warnings, and the library MAY apply rate limiting or downsampling. The spec recommends consumers structure subscriptions to avoid non-streamable operators where possible (e.g., subscribe to the underlying selection and apply ranking/composition in the consumer).

### 7.4 Delivery targets

```
DeliveryTarget =
  | webhook(url: URL, headers?: Map<string, string>)
  | mcp_channel(serverId: string, channelId: string)
  | in_process_callback(fn: Function)
  | persistent_queue(queueId: string)
  | log_sink(corpusId: CorpusId)
```

Delivery targets are pluggable. Standard targets cover webhooks, MCP channels (for AI-agent consumers), in-process callbacks (for tight coupling), persistent queues (for guaranteed-delivery integration), and log sinks (for writing notifications back into a designated corpus).

### 7.5 Delivery semantics

The library provides **at-least-once delivery** with **idempotency keys** and **causal ordering**:

- Every notification has a unique idempotency key (`subscriptionId + corpusTimestamp + matchingClaimId`)
- Consumers are expected to be idempotent against retries
- Notifications from a single subscription are delivered in causal order (corpus-timestamp-ordered)
- Notifications from different subscriptions have no cross-subscription ordering guarantee

Stronger semantics (exactly-once, cross-subscription ordering) require coordination with the consumer and are not provided by default.

### 7.6 Backpressure

When a consumer is slower than the rate of notifications, the library applies the configured backpressure policy:

```
BackpressurePolicy =
  | block_writes                                   -- writes wait until subscriber catches up
  | buffer(capacity: Int)                          -- buffer up to N notifications, drop after
  | drop_with_warning                              -- log and skip notifications when over capacity
  | persist_to_queue(queueId: string)              -- offload to persistent queue
```

**`block_writes`** — for critical subscriptions where delivery is mandatory. Couples writer latency to subscriber speed. Use sparingly.

**`buffer(capacity)`** — for typical subscriptions. Bounded buffering with drop-after-capacity.

**`drop_with_warning`** — for low-priority subscriptions where missed events are acceptable.

**`persist_to_queue`** — for subscriptions that must not drop and cannot block writes. Offloads to a separate persistent queue (Kafka, NATS, etc.).

### 7.7 Lifecycle

```
LifecyclePolicy =
  | until_cancelled                                -- runs until explicitly cancelled
  | until_event(predicate: EventPredicate)         -- runs until matching event
  | ttl(duration: Duration)                        -- expires after duration
  | composite(policies: List<LifecyclePolicy>)     -- any condition terminates
```

Subscriptions can be cancelled explicitly via the SubscriptionHandle, or expire automatically per the lifecycle policy. Cancellation is irreversible.

### 7.8 Subscription state

Subscriptions with `on_transition` triggers maintain state to evaluate transitions. The library stores per-subscription state separately from the corpus:

```
SubscriptionState {
  subscriptionId  : SubscriptionId
  query           : AlgebraExpression
  lastResultHash  : Hash                           -- for transition detection
  lastFiredAt     : Instant
  deliveryCount   : Int
  failureCount    : Int
  ...
}
```

Subscription state is durable. After a library restart, subscriptions resume from their last known state without missing or duplicating notifications (modulo at-least-once semantics).

---

## 8. Access control integration

### 8.1 Authorization adapter protocol

The library does not implement authorization internally. It delegates to an authorization adapter that conforms to:

```
AuthorizationAdapter {
  canRead(principal: Principal, corpus: CorpusId, claim?: Claim) → Decision
  canWrite(principal: Principal, corpus: CorpusId, candidate: CandidateClaim) → Decision
  canSubscribe(principal: Principal, corpus: CorpusId, query: AlgebraExpression) → Decision
  canAdmin(principal: Principal, corpus: CorpusId) → Decision
}

Decision = allowed | denied(reason: string)
```

Bedrock is a reference implementation of this protocol. The library is engine-agnostic — any system implementing the protocol works.

### 8.2 Enforcement points

The library MUST call the authorization adapter at every:

- Read (snapshot query) — `canRead` per corpus referenced
- Write — `canWrite` per claim being committed
- Subscribe — `canSubscribe` per corpus referenced
- Catalog operation — `canAdmin` for schema/policy modifications

Authorization decisions are themselves written to a designated audit corpus, providing a queryable record of access patterns.

### 8.3 Row-level access

Per-claim authorization is supported via `canRead(principal, corpus, claim)`. When this returns `denied` for individual claims, those claims are filtered from query results — the query succeeds but returns the visible subset. This implements row-level access control without requiring queries to know about authorization.

---

## 9. Storage adapter protocol

The library is implemented over pluggable storage adapters. Each adapter conforms to:

```
StorageAdapter {
  -- Claim operations
  insertClaim(claim: Claim) → Result
  getClaim(id: ClaimId) → Claim?
  deleteClaim(id: ClaimId) → Result                -- soft delete (deprecation)

  -- Bulk operations
  insertBatch(claims: List<Claim>) → BatchResult
  query(plan: ExecutionPlan) → ClaimIterator

  -- Indexes
  ensureIndex(spec: IndexSpec) → Result
  dropIndex(id: IndexId) → Result

  -- Transactions
  beginTransaction() → TransactionHandle
  commit(tx: TransactionHandle) → Result
  rollback(tx: TransactionHandle) → Result

  -- Subscriptions (optional; adapter may not support push)
  subscribeChanges(filter: ChangeFilter, callback: ChangeCallback) → SubscriptionHandle?

  -- Metadata
  capabilities() → AdapterCapabilities
}
```

Standard adapters:

- **SQLite** — embedded; single-writer; cheap for solo deployments
- **Postgres** — networked; multi-writer; production-grade
- **DuckDB** — analytical; column-oriented; good for time-series and aggregations
- **Vector indices** (Chroma, Qdrant, etc.) — for similarity-heavy access patterns
- **Hybrid** — composes multiple adapters with the library routing query parts to appropriate stores

Adapters declare their capabilities (`AdapterCapabilities`) so the query optimizer can choose execution plans accordingly. An adapter that supports semantic search natively (Chroma) will be routed similarity queries; an adapter that doesn't (SQLite) will fall back to in-memory similarity over filtered candidates.

---

## 10. Motivating queries

This section presents five worked queries that constrain the spec. Each is expressed in the algebra and demonstrates specific operators or interactions.

### 10.1 Query 1 — context assembly for architecture review

**Scenario**: A workflow's compile step needs to assemble context for an architecture-review subtask on the Canopy lineage block work. Find claims about the lineage block design that are currently believed, semantically similar to the query, not contradicted by higher-confidence claims, with full evidence chains, formatted as a 12k token XML context.

```
let corpus_now    = τ_now(corpus("workspace:canopy"))
let scoped        = σ_subject=lineage-block (corpus_now)
let decayed       = δ_exponential(half_life=30d) (scoped)
let validated     = σ_status=validated ∧ confidence>0.7 (decayed)
let contradictions= ⊥(validated)
let resolved      = resolve_deprecate_lower(contradictions, validated)
let ranked        = ρ_cosine, "lineage block schema considerations" (resolved)
let with_evidence = γ_2(ranked)
let composed      = κ_xml, 12000_tokens (with_evidence)
return composed
```

Demonstrates: temporal slicing, decay, confidence filtering, contradiction resolution, similarity ranking, provenance traversal, composition.

### 10.2 Query 2 — multi-corpus layered retrieval

**Scenario**: Backend subagent invoked for a NestJS task in CrewTracks. Assemble context from general NestJS knowledge, CrewTracks-specific NestJS knowledge, and the backend-role tag-scoped claims, with layered override semantics.

```
let nestjs_base   = δ_default(τ_now(σ_status=validated ∧ confidence>0.6 (corpus("wiki:nestjs-general"))))
let crewtracks    = δ_default(τ_now(σ_status=validated ∧ confidence>0.6 (corpus("wiki:crewtracks-modules"))))
let backend_role  = δ_persona(τ_now(σ_status=validated ∧ confidence>0.5 (σ_tag=role:backend (corpus("default")))))

let layered_kb    = crewtracks ⊳ nestjs_base
let with_role     = backend_role ⊳ layered_kb

let ranked        = ρ_cosine, task_query (with_role)
let with_evidence = γ_2(ranked)
let composed      = κ_xml, 12000_tokens (with_evidence)
return composed
```

Demonstrates: multi-corpus queries, the layered-override operator (⊳), per-corpus decay and confidence settings, role-as-tag (not role-as-entity).

### 10.3 Query 3 — time-traveling synthesis with derived write

**Scenario**: Weekly project-margin check. For project Lincoln Street, determine whether risk has elevated meaningfully between four weeks ago and one week ago. If so, write a derived `at-risk` claim with provenance.

```
let project        = "lincoln-street"
let week_ago       = now() - 7d
let month_ago      = now() - 28d
let recent_cutoff  = now() - 72h

let signals_week   = σ_subject∈{cost-variance, schedule-slip, quality-issue} ∧ status=validated (
                       τ_known(week_ago) (σ_scope.entityId=project (corpus("workspace:acme")))
                     )

let signals_month  = σ_subject∈{cost-variance, schedule-slip, quality-issue} ∧ status=validated (
                       τ_known(month_ago) (σ_scope.entityId=project (corpus("workspace:acme")))
                     )

let risk_week      = ⊕_synthesize_as<at-risk, project.risk-elevation>_evidence-pooled (signals_week)
let risk_month     = ⊕_synthesize_as<at-risk, project.risk-elevation>_evidence-pooled (signals_month)

let risk_delta     = effective_confidence(risk_week) - effective_confidence(risk_month)

let recent_alerts  = σ_subject=at-risk ∧ scope.entityId=project ∧ recorded>recent_cutoff (corpus("workspace:acme"))

if risk_delta > 0.15 and recent_alerts is empty:
  let derived = derive_claim_from(
    query        = (the synthesis query above),
    target_subject = "at-risk",
    target_key   = "project.risk-elevation",
    scope        = {entityId: project, workspace: "acme"},
    combination  = rule_evidence_pooled
  )
  commit_derived(
    candidate      = derived,
    provenance_query = serialize(synthesis_query),
    corpus_state   = current_state(),
    policy         = reject_on_contradiction
  )
```

Demonstrates: bitemporal time-travel (`τ_known`), belief synthesis (`⊕_synthesize_as`), the algebra-to-computation boundary (arithmetic over derived values), derived writes with full provenance.

### 10.4 Query 4 — streaming subscriptions

**Scenario**: An architecture-review-panel run is active. Three subscriptions need to fire reactively as the corpus evolves during the run.

```
-- Subscription 1: push panel insights to Brett's Pilot session
subscribe(
  query     = σ_subject=panel-insight ∧ scope.runId=R ∧ confidence>0.7 (corpus("workspace:canopy")),
  trigger   = on_every_match,
  target    = mcp_channel(server="pilot", channel="lineage-block-discussion"),
  lifecycle = until_event(workflow_completed(R))
)

-- Subscription 2: alert orchestrator on contradictions in the run
subscribe(
  query     = ⊥(σ_status=validated ∧ scope.runId=R (corpus("workspace:canopy"))),
  trigger   = on_transition(direction=to_nonempty),
  target    = webhook("https://orchestrator/run-contradiction"),
  lifecycle = until_event(workflow_completed(R))
)

-- Subscription 3: audit-log every claim in the run
subscribe(
  query     = σ_scope.runId=R (corpus("workspace:canopy")),
  trigger   = on_every_match,
  target    = log_sink(corpus="audit:run-events"),
  lifecycle = until_event(workflow_completed(R))
)
```

Demonstrates: three trigger semantics, three delivery target types, lifecycle policies tied to corpus events.

### 10.5 Query 5 — atomic workflow-completion writes

**Scenario**: An architecture-review-panel run completes. Multiple claims must be written atomically — panel insights, synthesized decision, run summary, audit event.

```
transaction {
  -- Per-agent panel insights
  for agent_output in run_outputs:
    for insight in extract_insights(agent_output):
      commit_candidate(
        Claim {
          subject = "panel-insight",
          key = "review.lineage-block.insight",
          scope = { runId: R, persona: agent_output.persona },
          value = insight.content,
          confidence = beta_from_raw(insight.raw_confidence, source="llm"),
          valid = [now, ∞),
          source = "llm",
          provenance = { workflow: "architecture-review-panel", run: R, persona: agent_output.persona },
          evidence = insight.evidence_refs
        },
        policy = accept_but_mark
      )

  -- Synthesized decision (derived from the insights just written)
  let decision_query = ρ_arbitration(σ_subject=panel-insight ∧ scope.runId=R (corpus("workspace:canopy")))
  let decision_candidate = derive_claim_from(
    query = decision_query,
    target_subject = "decision",
    target_key = "review.lineage-block.verdict",
    scope = { runId: R },
    combination = rule_weighted_average
  )

  commit_derived(
    candidate = decision_candidate,
    provenance_query = serialize(decision_query),
    corpus_state = current_state(),
    policy = reject_on_contradiction
  )

  -- Run summary
  commit_candidate(
    Claim {
      subject = "run-summary",
      key = "workflow.architecture-review-panel.summary",
      scope = { runId: R },
      value = { participants: [...], duration: ..., consensus_level: ... },
      confidence = beta_from_raw(1.0, source="workflow"),
      valid = [now, ∞),
      source = "workflow",
      provenance = { workflow: "architecture-review-panel", run: R }
    },
    policy = always_accept
  )

  -- Audit event
  commit_candidate(
    Claim {
      subject = "audit-event",
      key = "workflow.run.completed",
      scope = { runId: R, workspace: "canopy" },
      value = { final_state: "consensus_reached", claim_count: counts },
      confidence = beta_from_raw(1.0, source="workflow"),
      valid = [now, now],
      source = "workflow",
      provenance = { workflow: "architecture-review-panel", run: R }
    },
    policy = always_accept
  )
}
```

Demonstrates: transactional batch writes, per-claim contradiction policies, derived writes within transactions, intra-transaction references (the decision query reads the panel insights committed earlier in the same transaction).

---

## 11. Open questions (deferred to v2)

### 11.1 Schema evolution

The spec defines schemas as versioned but does not specify migration semantics in depth. Real systems hit schema evolution constantly — claims get new fields, value types shift, scope conventions change. v2 needs:

- Explicit migration declaration (how to transform v1 claims to v2)
- Read-time schema coercion (when querying older claims under a newer schema)
- Validation strictness levels (strict, permissive, coerce)

This is a sizable subsystem and was deliberately deferred until v1's core is stable.

### 11.2 Federation

The spec assumes a single Mneme deployment. Multi-deployment scenarios (a Polis instance per client, queries that span across them) are unspecified. v2 needs:

- Identity and authentication across deployments
- Cross-deployment query semantics (latency, consistency)
- Conflict resolution when federated corpora disagree

### 11.3 Cost models and query planning

The spec defines operators and their incremental-evaluation classifications but does not provide cost models. A real query planner needs:

- Per-operator cost functions parameterized by input size and adapter capabilities
- Estimated cardinality propagation through query plans
- Plan-equivalence detection for plan caching

This is normal query-optimizer work; deferred because it depends on having real workloads to calibrate against.

### 11.4 Multi-writer conflict resolution

The spec assumes the storage adapter handles multi-writer races (e.g., Postgres MVCC, SQLite single-writer). For deployments needing distributed multi-writer semantics, additional design is needed:

- Causal ordering across writers
- Conflict-free replicated data type (CRDT) semantics for specific operators
- Quorum-based commit protocols

This is an extension point; v1 supports it via the storage adapter's transaction primitives but does not specify distributed-systems semantics in detail.

### 11.5 Observability of the library itself

The library should expose its own observability — metrics, traces, slow-query logs, subscription health. v2 should specify this surface as a first-class concern, both because operators need it and because it integrates with the broader audit story (the library's own operations are themselves auditable claims).

---

## 12. Glossary

**Algebra** — the set of typed operators and equational laws that define legal query expressions.

**Bitemporal** — having two distinct time dimensions: valid-time (when the claim's content was true) and transaction-time (when the claim entered the corpus).

**Candidate claim** — a claim that has been emitted but not yet promoted to the corpus.

**Claim** — the basic unit of typed data in a corpus; an assertion with confidence, scope, provenance, and evidence.

**Composition** — the terminal operator family that produces an LLM-ready context document from a ranked corpus.

**Corpus** — a named, schema-bound, access-controlled collection of claims.

**Decay** — confidence adjustment as a function of time, applied at query time rather than write time.

**Derived claim** — a claim produced by a query expression, with the query and corpus state recorded as provenance.

**Effective confidence** — the post-decay, post-weighting confidence used in queries; distinct from raw stored confidence.

**Evidence reference** — a pointer from a claim to a supporting source (another claim, a document, an external resource).

**Provenance** — the structured record of where a claim came from (workflow, run, persona, derivation query).

**Scope** — dynamic context qualifying a claim's static key (workflow ID, entity ID, persona ID, etc.).

**Streamable operator** — an operator that can be evaluated incrementally on each new write in O(1) or O(log n) time.

**Subject** — the top-level namespace component of a claim's key (e.g., `user`, `repo`, `workflow`).

**Subscription** — a long-running query registered against the corpus, with trigger semantics that determine when to deliver notifications.

**Transaction** — an atomic batch of writes that become visible together or not at all.

---

## Appendix A — Source-weight defaults

| Source        | Weight | Half-life (decay default) | Notes                                    |
|---------------|--------|---------------------------|------------------------------------------|
| manual        | 1.3    | 180 days                  | Explicit user input                      |
| verification  | 1.2    | 90 days                   | Verified from tests/build                |
| workflow      | 1.0    | 60 days                   | Standard workflow output                 |
| heuristic     | 0.9    | 30 days                   | Deterministic extraction                 |
| llm           | 0.7    | 14 days                   | LLM inference                            |
| imported      | 0.6    | 60 days                   | External sources                         |

These are corpus-level defaults; individual corpora MAY override per their schema.

---

## Appendix B — Standard similarity functions

| Function           | Input types                  | Output range | Cost              | Notes                              |
|--------------------|------------------------------|--------------|-------------------|------------------------------------|
| `sim_cosine`       | Vector × Vector              | [0, 1]       | O(d) per claim    | Requires embedding adapter         |
| `sim_jaccard`      | Set × Set                    | [0, 1]       | O(n + m)          | Token sets                         |
| `sim_bm25`         | Text × Text                  | [0, ∞)       | O(n)              | Normalized to [0, 1] for ranking   |
| `sim_exact`        | Any × Any                    | {0, 1}       | O(1)              | Binary match                       |
| `sim_structural`   | Typed × Typed                | [0, 1]       | varies            | Domain-specific; user-defined      |

Similarity functions are registered per corpus in the schema's `similarities` map.

---

## Appendix C — Reserved scope fields

The library reserves the following scope field names with defined semantics:

- `workflowName` — name of the workflow that produced or consumed this claim
- `runId` — specific run identifier
- `nodeId` — specific node within a workflow run
- `personaId` — persona associated with the claim
- `teamId` — team associated with the claim
- `entityType` — type of the primary entity this claim is about
- `entityId` — identifier of the primary entity
- `topic` — topical grouping
- `modelId` — LLM model associated with the claim (for LLM-source claims)

Custom scope fields are permitted but MUST NOT shadow these reserved names.

---

## End of v0.1 draft

This spec is constrained by five worked queries. Operators and write semantics are stable enough to implement against. The flagged gaps (§11) are real but defer-able to v2 without compromising the v1 core.

Next steps: implement the SQLite reference adapter, port one existing system (e.g., RaState's knowledge layer) to consume the library, and use that experience to surface refinements before publishing v1.0.
