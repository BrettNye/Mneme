# Mneme Specification v0.2 (consolidated)

**Status:** Canonical. Folds and supersedes: Mneme v0.1 spec, v0.1.1 errata, v0.2 expansion (revised). Errata corrections are applied inline; capability additions integrated; erasure deferred (Appendix H).

**Tier legend:** [C] Core — every implementation MUST support. [P] Protocol extension — declared protocol, reference impl provided, opt-in. [Prof] Customer-gated profile — specified, not shipped.

**Implementation-neutral:** pseudocode notation; storage adapters named; no host language mandated (see §1.4, Appendix G).

## Table of contents

- §0 Conventions
- §1 Motivation and reframe
- §2 Core types
- §3 Catalog model
- §4 Query algebra
- §5 Distribution protocol [P]
- §6 Catalog operations
- §7 Write model
- §8 Subscription model
- §9 Access control integration
- §10 Storage adapter protocol
- §11 Worked queries
- §12 Glossary

Appendices: A Defaults · B Similarity functions · C Reserved scope fields · D Math re-derivations · E Design decisions · F Audit reconciliation history · G Deferred/out-of-scope · H Erasure profile [Prof]


---

## 0. Conventions

This section pins the normative language, the tier model, the foundational confidence convention, and the operator notation that the rest of the specification depends on. Every confidence formula in later sections is derived under the convention fixed in §0.3.

### 0.1 Normative language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **MAY**, and **OPTIONAL** in this document are to be interpreted as described in RFC 2119 / RFC 8174.

- **MUST** / **REQUIRED** / **SHALL** — an absolute requirement of the specification. A conforming implementation cannot omit it.
- **SHOULD** / **RECOMMENDED** — there may exist valid reasons to deviate in particular circumstances, but the full implications must be understood and weighed before choosing a different course.
- **MAY** / **OPTIONAL** — the item is truly optional; implementations choose freely, and interoperability MUST NOT depend on the choice.

Unless a clause is explicitly scoped to a protocol extension `[P]` or a customer-gated profile `[Prof]`, normative requirements apply to the core `[C]` tier and bind every implementation.

### 0.2 Tier model and badge legend

Mneme commits to a three-tier model that distinguishes core algebra from protocol-based extensions from customer-gated profiles. Each operator, type, and capability in this document carries one of three badges:

- **`[C]` Core** — operators and types that all Mneme implementations MUST support. These are the correctness obligations of the library. The core tier includes the entire v0.1.1 algebra plus the aggregation operators and n-way contradiction clusters introduced in v0.2. Anything unbadged is core.
- **`[P]` Protocol extension** — capabilities exposed through a declared protocol (e.g. `DistributionProtocol`, `SimilarityFn`, `AuthorizationAdapter`). A reference implementation is provided, but the protocol is the contract: consumers MAY supply their own implementation. Dirichlet, Gaussian, and Kalman fusion live here rather than in core, which narrows the core's correctness surface. Protocol extensions are opt-in.
- **`[Prof]` Customer-gated profile** — capabilities specified architecturally but not shipped until a specific customer requirement justifies the investment. The erasure profile (Appendix H) is the first such profile; federation, schema migration, and distributed multi-writer semantics are expected future profiles.

This tiering is structurally enforced, not merely documentary. A corpus declares the capabilities it depends on through a `requiredTiers` field:

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

A Mneme deployment validates at startup that every required tier for each of its hosted corpora is available. Queries that reference operators outside the deployment's available tier set fail at parse time with a clear error.

### 0.3 The α, β convention (foundational)

The `Confidence` type is a Beta distribution parameterized by α and β. Mneme pins α and β to the standard subjective-logic relation. Given evidence counts `(r, s)` representing positive and negative observations, a non-informative prior weight `W`, and a base rate `a`:

```
α = r + a·W
β = s + (1−a)·W
```

That is, **α and β include the prior**. A claim with no evidence (`r = s = 0`) has `α = a·W` and `β = (1−a)·W`. For a symmetric prior (`a = 0.5`) with `W = 2`, a no-evidence claim is `Beta(1,1)` — the standard uninformative prior, for which belief is 0 and uncertainty is 1.

Recommended defaults:

- `W = 2` (non-informative prior weight)
- `a = 0.5` (symmetric base rate)

Corpora MAY override `W` and `a` via the corpus schema. When a corpus overrides either value, the values used MUST be recorded in the corpus catalog and propagated to all combination operations, so that pooling and synthesis use parameters consistent with how each input claim's α, β were constructed.

This convention is foundational: every α, β-dependent operation in this specification — the subjective-logic bridge, evidence pooling, the Dirichlet generalization, and the scalar-to-Beta and Beta-to-frame conversions — is re-derived under this exact convention in Appendix D. Where a formula references α, β, `W`, or `a`, it assumes the relation pinned here.

### 0.4 Operator notation

Each operator in the query algebra (§4) is presented with a type signature, an intuition, and an equational-law section. The following Greek-letter and symbolic operators are used throughout:

| Symbol | Name | Meaning |
| --- | --- | --- |
| `σ` | sigma | selection — filter a corpus to claims matching a predicate |
| `π` | pi | projection — restrict claims to a subset of fields |
| `⋈` | join | join across corpora or claim sets |
| `τ` | tau | temporal slicing — bitemporal time-travel over valid-time and recorded-time |
| `δ` | delta | decay — compute effective (time-adjusted) confidence |
| `ρ` | rho | similarity ranking |
| `γ` | gamma | provenance traversal |
| `⊥` | bottom | contradiction detection |
| `⊕` | oplus | belief combination (`⊕_dedupe`, `⊕_synthesize_as`) |
| `⊳` | rhd | layered override |
| `κ` | kappa | composition (and its component operators) |

Supporting type names: `Corpus` denotes a typed collection of claims; `RankedCorpus` is a corpus where each claim carries an associated score (typically a similarity score); `ComposedContext` is a token-budgeted, formatted document ready for LLM input.

---

## 1. Motivation and reframe

Mneme is a typed algebra and library specification for AI-memory retrieval. It defines a set of composable operators over a corpus of typed claims, plus a write and subscription model, plus a catalog model for naming and organizing corpora. The library implements the algebra over pluggable storage backends; it does not ship its own storage engine.

### 1.1 The problem this is solving

Current options for AI-memory retrieval fall into three categories, all of which are wrong for what AI memory actually needs:

**Opinionated memory products** (Mem0, Letta, Zep, Honcho) bake a theory of memory into the product. They work if your use case fits the embedded theory, and break otherwise. The theory itself is usually biologically inspired and carries assumptions that don't apply to stateless transformers.

**Vector databases** (Pinecone, Weaviate, Chroma, Qdrant) treat retrieval as semantic-similarity-with-metadata-filtering. That is one retrieval mode among many that AI memory needs. Confidence-weighted ranking, recency decay, structured-key lookups, temporal walks, contradiction-aware retrieval, persona-scoped slicing, outcome-correlated reweighting, and provenance traversal are all first-class needs that vector DBs handle awkwardly or not at all.

**Structured databases** (Postgres, SQLite, DuckDB) are powerful at queries but treat data as plain rows. They have no native primitives for the AI-specific dimensions — confidence, decay, provenance chains, contradiction detection, semantic similarity, bitemporal validity, persona scoping. Every application reimplements these in app code, often inconsistently.

The gap: no library treats *the access patterns of AI-memory retrieval* as the primary design surface. Mneme does.

### 1.2 The math-not-biology framing

Mneme is designed around the actual mathematics of LLM-based systems, not around biological metaphors of memory.

LLMs are deterministic functions from context to logits. They have no internal state between calls. Memory cannot live "inside" the model. What humans call "agent memory" is, mechanically, *additional input to a stateless function* — assembled at call time by an orchestration pipeline.

Under this framing:

- The "agent" is not a unit of cognition. It is the composition of (LLM function, prompt construction logic, retrieval logic, output processing). Memory belongs to the composition, not to the LLM.
- "Remembering" is not internal recall. It is *input curation* — selecting which past data becomes part of the current input.
- "Learning" is not weight updates. It is *changes to how curation happens over time*, driven by outcome data.
- "Identity" is not a persistent self. It is *the consistency of the prompt template and retrieval policy* across invocations.

### 1.3 Architectural consequences

The math-not-biology reframe has direct architectural consequences:

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

**This specification is implementation-neutral.** Types, operators, and protocols are presented in pseudocode notation, not in any particular programming language. Storage is engaged through named adapters — SQLite, Postgres, DuckDB, Chroma, and a Markdown-vault adapter are specified by name (see §10) — but no specific adapter is mandated for conformance. No host language is mandated: a conforming implementation MAY be written in any language whose type system can express the claim and corpus types. The choice of language for the reference implementation is deliberately deferred and tracked separately (see Appendix G).

### 1.5 Honest scope

Mneme is the typed algebra for **enterprise AI-orchestration memory with audit-grade provenance**. That is its target, and the spec is scoped to serve it well rather than to serve everything.

Mneme is explicitly **not a universal AI memory library**, and does not claim to be one. Vertical-specific needs — consumer-scale memory, regulatory erasure, sensor/measurement fusion — are served not by inflating the core but by appropriate adapter choices, protocol extensions `[P]`, and customer-gated profiles `[Prof]`. This is the rationale behind the three-tier model fixed in §0.2: the core stays small and provably correct, riskier or vertical-specific math lives behind declared protocols, and capabilities without a concrete customer remain specified-but-unshipped profiles rather than speculative core surface area. Erasure (Appendix H) is the first such profile; federation, schema migration, and distributed multi-writer semantics are expected future profiles.

---

## 2. Core types

The core types define the structural vocabulary of the algebra: the claim and its components (subject, key, scope, time, provenance, evidence), plus the `Confidence` type. This section specifies the *structural* core types. The confidence type and the subjective-logic bridge that depend on the α, β convention pinned in §0.3 are specified separately in §2.4 (Confidence) and §2.5 (the subjective-logic bridge); the types here reference `Confidence` by name without redefining its internals.

### 2.1 Claim

A claim is a typed tuple representing one assertion in the corpus.

```
Claim {
  id           : UUID                              -- unique identifier, assigned on promotion (the unique primary key)
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
  provenance   : Provenance                        -- run/node/persona that produced this (see §2.7)
  evidence     : Set<EvidenceRef>                  -- pointers to supporting sources (see §2.8)
  audience     : Audience                          -- persona-targeting hints
  tags         : Set<Tag>                          -- lightweight categorical hints
  schema       : SchemaVersion                     -- version of the claim type schema
}
```

Critical commitments:

**Confidence is a distribution, not a number.** The `Confidence` type is defined in §2.4 and its mathematics — the Beta/Dirichlet parameterization, the α, β convention, and the subjective-logic bridge — are specified in §2.4–§2.5 under the convention pinned in §0.3. A claim does not say "0.8 confidence" as a point estimate; it carries enough information to compute an *effective* confidence under a chosen policy. Effective confidence is computed at query time (via the δ operator), not at write time; the stored confidence is immutable history.

**Time is bitemporal.** Every claim carries both a *valid-time interval* (`valid` — when the claim's content was true about the world) and a *recorded instant* (`recorded` — when the claim entered the corpus). These are distinct dimensions and the algebra treats them separately (see §2.6 and the τ operator).

**Scope is dynamic context.** The `(subject, key)` pair is the *static* identity of what the claim is about; `scope` qualifies that with the *dynamic* situation in which the claim applies. Workflow names, entity IDs, run IDs, and persona IDs go in scope. Two claims with the same `(subject, key)` but different scopes are distinct facts, not duplicates (see §2.3).

**Status is a lifecycle, not a quality measure.** Confidence measures quality. `status` indicates where in the validation pipeline the claim sits.

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

**Empty scope.** The scopeHash of an empty scope is a single underscore character — i.e., `scopeHash = "_"`. This is the same convention used historically in RaState's claim store and is preserved here for consistency. An empty scope is not the absence of a hash; it hashes to this reserved sentinel.

**Indexing and uniqueness.** `(profile, key, scopeHash)` is a **non-unique index**, NOT a unique key. The unique primary key on a claim is the `id` field. Multiple claims MAY share the same `(profile, key, scopeHash)` triple — typically because one is currently `validated` and others are `deprecated` supersession history. Queries that need "the currently-validated claim with this triple" MUST filter by status; the algebra's standard `σ_status=validated` does this.

This has a direct consequence for write-time contradiction checking (§7): the *cheap* contradiction check on a `(profile, key, scopeHash)` match MUST additionally filter by status to find the currently-validated competing claim, not just any historical claim. Without the status filter, the cheap check would treat deprecated supersession history as live contradictions.

### 2.4 Confidence `[C]`

Confidence is a distribution, not a point estimate, represented by a parameterized type. The default implementation uses a Beta(α, β) distribution over evidence weights; the algebra is generic over the distribution type via the distribution protocol (§5).

```
Confidence {
  distribution : DistributionType                  -- distribution ∈ {beta, scalar, dirichlet, custom}
  parameters   : DistributionParameters            -- e.g., {alpha: 8.2, beta: 1.4}
  raw          : Number                            -- raw 0..1 from source (pre-weighting)
  effective    : Number?                           -- cached point estimate (computed)
}
```

`distribution ∈ {beta, scalar, dirichlet, custom}`. The `beta` and `scalar` distributions are core `[C]`; `dirichlet` and other multi-category or fused distributions are protocol extensions `[P]` (§5). A scalar confidence (point estimate only) is supported via `distribution = scalar`, which keeps Mneme compatible with simple confidence models while allowing richer distributions where needed.

**Effective mean.** For a Beta(α, β) confidence the effective point estimate is the Beta mean:

```
effective mean = α/(α+β)
```

Under the α, β convention pinned in §0.3 (`α = r + a·W`, `β = s + (1−a)·W`), this is the projected probability of the corresponding subjective-logic opinion (§2.5). Effective confidence is computed at query time (via the δ operator), not at write time: stored confidence is *immutable history*, perceived confidence is *computed*.

**Source weighting at promotion.** Raw source confidence is scaled by a per-source weight applied at promotion time (§6.2), before the Beta parameters are formed. The source-weight defaults (with decay half-lives) are tabulated in Appendix A; corpora MAY override them per their schema.

### 2.5 Subjective-logic bridge `[C]`

The bridge maps a Beta(α, β) confidence to a binomial subjective-logic opinion `(belief, disbelief, uncertainty, base_rate)`, under the convention pinned in §0.3 with non-informative prior weight `W` and base rate `a`. Because `α + β = r + s + W` by that convention, the denominator is the evidence total including prior, computed directly from `α + β`:

```
belief = (α−a·W)/(α+β) = r/(r+s+W)
disbelief = (β−(1−a)·W)/(α+β) = s/(r+s+W)
uncertainty = W/(α+β) = W/(r+s+W)
base_rate = a
projected = α/(α+β)
```

The projected probability `projected = α/(α+β)` equals the Beta effective mean of §2.4, so the opinion and the confidence point estimate agree by construction.

**Worked example — vacuous opinion.** `Beta(1,1)` under `W=2, a=0.5`:

- `r = α − a·W = 1 − 1 = 0`
- `s = β − (1−a)·W = 1 − 1 = 0`
- `belief = 0/2 = 0`
- `disbelief = 0/2 = 0`
- `uncertainty = 2/2 = 1`
- `projected = 1/2 = 0.5`

This is the correct vacuous opinion for a no-evidence claim: no belief either way, full uncertainty, base-rate-driven expected probability. (A bridge that yielded non-zero belief or `uncertainty < 1` for `Beta(1,1)` would be wrong; the prior must not be double-counted.)

**Dirichlet generalization `[P]`.** For `Dirichlet(α₁, …, αₖ)` over frame `{x₁, …, xₖ}` with base rates `a₁, …, aₖ`, the bridge generalizes to a multinomial opinion:

```
belief(xᵢ) = (αᵢ−aᵢW)/Σαⱼ
uncertainty = W/Σαⱼ
base_rate(xᵢ) = aᵢ
projected(xᵢ) = αᵢ/Σαⱼ
```

This has the same shape as the binary case. The vacuous-opinion property holds: `Dirichlet(W·a₁, …, W·aₖ)` yields zero belief on every singleton and full uncertainty.

*W-scaling caveat for k > 2.* The `W=2` default is tuned for binary frames. For `k > 2` categories with symmetric base rate `aᵢ = 1/k`, each category receives prior weight `W/k`; with `W=2, k=5` that is only `0.4` per category — a very weak prior. Consumers using large frames should consider scaling `W` with frame size (Jøsang's literature uses both `W = 2` constant and `W = k` scaling depending on application). The corpus schema MAY override `W` per-key for keys with declared multi-category value schemas; when it does not, `W=2` applies regardless of frame size, with prior strength diminishing per category as the frame grows.

**Dempster-Shafer mass functions.** A subjective-logic opinion converts to a Dempster-Shafer mass function on the frame:

```
mass({xᵢ}) = belief(xᵢ)            for each singleton i
mass(frame) = uncertainty           on the universal set {x₁, …, xₖ}
mass(∅) = 0                         by definition
```

Combination of two opinions via Dempster's rule operates on the mass functions, then converts back to an opinion (or directly to combined Beta/Dirichlet parameters using the inverse of the bridge above). See Jøsang, *Subjective Logic* (Springer, 2016), chapters 3 and 6, for the formal treatment of binomial and multinomial opinions and their bridge to Dempster-Shafer theory.

### 2.6 Time

**Valid-time interval** is `[from, to)` where `from` and `to` are `Instant` values (ms since epoch). `to` MAY be `∞` for claims with no end time. Open intervals are used throughout: `[a, b)` includes `a` and excludes `b`.

**Recorded** is an `Instant` representing transaction time — when the claim was committed to the corpus. The library assigns this at commit time; writers do not specify it.

The library MUST guarantee that `recorded` is monotonically non-decreasing across the global commit order. If two commits occur with the same logical timestamp (e.g., within a batch), they are totally ordered by an additional tiebreaker (a per-commit sequence number).

These two dimensions are queried independently by the temporal-slicing operator τ (§4): valid-time answers "what was true about the world at T," recorded-time answers "what had been written to the corpus by T," and their composition answers "what would the system have computed if asked at T about T."

### 2.7 Provenance

Provenance records where the claim came from.

```
Provenance {
  workflow?     : string                           -- workflow definition name
  runId?        : string                           -- specific run that produced this
  nodeId?       : string                           -- node within the workflow
  persona?      : string                           -- persona that produced this
  artifactId?   : string                           -- specific artifact reference
  derivedFrom?  : DerivationProvenance             -- if this is a derived claim (see §7)
}

DerivationProvenance {
  queryExpression        : SerializedAlgebraExpression  -- the query that produced this
  corpusState            : LogicalTimestamp             -- corpus state at evaluation
  combinationRule        : string                       -- rule used (if synthesis)
  inputClaims            : Set<ClaimId>                 -- contributing claims
  inputHashes            : Map<ClaimId, ContentHash>    -- content hash of each input at derivation time (App H.3)
  similarityVersions     : Map<SimilarityFunctionId, Version>  -- versions of similarity fns used
  embeddingModelVersions : Map<EmbeddingModelId, Version>      -- versions of embedding models used
  evaluationClock        : Instant                      -- pinned eval time for time-dependent operators
}
```

Derivation provenance makes derived claims *reproducible*: a consumer can re-run the serialized query against the recorded corpus state and verify they get the same derived claim. This is the audit-grade-provenance guarantee. The reproducibility guarantee is conditional on version availability — replay verifies the result *iff* all input claims are present, all referenced similarity-function and embedding-model versions remain available in the catalog, and the pinned `evaluationClock` is used for time-dependent operators. The full replay-status stratification is specified in §7.

`similarityVersions` records the version of every similarity function used in the query; `embeddingModelVersions` records the version of every embedding model used (e.g., when `ρ_cosine` is invoked, the embedding model's version identifier is captured). `evaluationClock` pins the time at which time-dependent operators (decay, `τ_now`) are evaluated, eliminating "decay drift" during replay — re-evaluation uses the pinned clock, not the current clock.

These three fields are mandatory for any derived write whose query references similarity-based operators, and recording them is *irreversible at write time*: a derivation committed without them cannot retroactively gain them. Implementations MUST begin recording version information immediately, even before the broader replay-verification machinery is built (see §7).

`inputHashes` records the content hash of each input claim at the moment of derivation, keyed by claim id. Like the version fields it is *irreversible at write time* and MUST be recorded immediately — it is the banked prerequisite of Appendix H.3 that lets a future erasure profile (Appendix H) offer integrity-verifiable replay after an input has been erased. A derivation committed without input hashes is permanently limited to acknowledgment-only reproducibility for any input that is later erased; this is why the field is mandatory now rather than deferred with the erasure profile itself.

### 2.8 EvidenceRef

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

Evidence forms a directed acyclic graph (DAG) over claims. Cycles are forbidden — a claim cannot transitively cite itself, and self-citation is therefore prohibited. The library MUST enforce acyclicity at write time. The provenance-traversal operator γ (§4) walks this DAG to a bounded depth; acyclicity guarantees that traversal terminates and that the transitive closure is finite.

---

## 3. Catalog model

A **corpus** is a named, schema-bound, access-controlled collection of claims. The library manages a *catalog* of corpora, and queries reference corpora by name. Corpora are first-class: a deployment routinely hosts multiple corpora with different schemas, policies, and storage backends, and a single query MAY reference several of them at once. Treating "the corpus" as one global entity is incorrect.

This section defines the four catalog types: the `Corpus` entity (§3.1), the `ClaimSchema` that types its claims (§3.2), the `CorpusDefaults` that queries inherit (§3.3), and the `AccessPolicy` that authorizes access (§3.4). Catalog *operations* — creating, updating, discovering, and querying across corpora — are specified in §6.

### 3.1 Corpus

A corpus is a named entity in the catalog. Queries reference it by `id`.

```
Corpus {
  id            : CorpusId                          -- stable identifier (kebab-case)
  displayName   : string                            -- human-readable
  schema        : ClaimSchema                        -- type definition (see §3.2)
  policy        : AccessPolicy                       -- read/write authorization (see §3.4)
  defaults      : CorpusDefaults                     -- default behaviors (see §3.3)
  storage       : StorageAdapterRef                  -- which adapter backs this corpus
  requiredTiers : Set<TierRequirement>               -- capability tiers this corpus depends on (see §0.2)
  metadata      : Record<string, any>                -- arbitrary tags
  createdAt     : Instant
  updatedAt     : Instant
}
```

Standard corpus identifiers follow a `{kind}:{name}` convention:

- `wiki:nestjs-general` — a wiki-style knowledge collection
- `persona:backend` — a persona-scoped claim collection
- `workspace:crewtracks-modules` — workspace-scoped claims
- `audit:run-events` — an append-only event log

The prefix is convention, not enforcement. The library treats corpus IDs as opaque strings; the `{kind}:` prefix is a documentation aid.

**Tier requirements.** The `requiredTiers` field makes the tier model (§0.2) structurally enforced rather than merely documentary. Each corpus declares the capability tiers it depends on as a set of `TierRequirement` values, whose variants are defined in §0.2:

- `core` — only core `[C]` operators are needed.
- `protocol(name)` — a specific protocol extension `[P]` is needed (e.g. `"dirichlet"`, `"gaussian"`).
- `profile(name)` — a customer-gated profile `[Prof]` is needed (e.g. `"erasure"`).

A Mneme deployment validates at startup that every required tier for each of its hosted corpora is available in that deployment. A corpus whose `requiredTiers` name a protocol extension or profile the deployment does not provide MUST be rejected at startup with a clear error, rather than failing opaquely at query time. Queries that reference operators outside the deployment's available tier set fail at parse time (see §0.2).

### 3.2 ClaimSchema

A claim schema declares the types and constraints for claims in a corpus.

```
ClaimSchema {
  version            : SchemaVersion                 -- e.g., "1.0.0"
  subjects           : Set<Subject>                  -- allowed subjects in this corpus
  keys               : Map<Subject, KeyPattern>      -- allowed keys per subject
  scopeFields        : Map<string, FieldType>        -- declared scope fields and types
  valueSchemas       : Map<Key, ValueSchema>         -- value type per key (optional)
  keyCardinality     : Map<Key, "single" | "multi">  -- cardinality intent per key (optional)
  required           : Set<FieldName>                -- which top-level fields are required
  similarities       : Map<ValueTypeId, SimilarityFn>-- registered similarity functions
  scalarPseudocount  : Map<Source, Number>           -- per-source pseudo-count for scalar→Beta coercion
}
```

Schemas declare what *can* exist in the corpus. Writes that do not conform are rejected. Queries reference field names that MUST exist in the schema; a missing field is a query-time error, not a silent empty result. Where a key declares a `valueSchema`, value predicates against that key are type-checked at parse time against the declared structure (see §4).

**`keyCardinality` — accumulation vs. conflict.** Keys not present in the map default to `"single"`. A `"single"` key asserts that at most one value is correct for a given `(subject, key, scope)` triple — multiple distinct values are a contradiction. A `"multi"` key asserts that accumulation is expected and correct: distinct values are not in conflict, they are members of a set. Cardinality is domain knowledge that cannot be inferred from the data; it MUST be declared by the schema author, not derived. Validation of this field is a manual strict check — there is no runtime schema-validation library (mirroring the strict-scope discipline of §3.1).

Schema versions are tracked per claim: the `Claim.schema` field records the version under which each claim was written. The catalog tracks active schema versions and migration paths.

**Scalar-to-Beta pseudo-counts are required, with no silent default.** When a combination operation must coerce a scalar confidence into a Beta distribution, it needs a pseudo-count — the strength-of-evidence the scalar represents, expressed as an effective observation count. The same scalar mean maps to wildly different evidence weights depending on this choice: a scalar of `0.8` becomes `Beta(8, 2)` or `Beta(80, 20)` with the same mean but ten times the evidence weight, which silently determines how much a scalar-source claim dominates in subsequent pooling. The conversion (derived in Appendix D) is:

```
scalar_to_beta(scalar, pseudocount, base_rate):
  α = scalar · pseudocount + base_rate · W
  β = (1 − scalar) · pseudocount + (1 − base_rate) · W
```

The `pseudocount` parameter is **REQUIRED, not defaulted**. It is supplied in one of two ways:

1. The corpus schema declares per-source pseudo-counts via `scalarPseudocount: Map<Source, Number>`; or
2. The conversion operator takes `pseudocount` as an explicit argument.

Implementations **MUST NOT** default the pseudo-count silently. A combination operation that requires scalar-to-Beta coercion without a declared or supplied pseudo-count **MUST fail at parse time**. (Guidance on choosing pseudo-counts by source trust is in Appendix A; the values themselves are corpus-calibrated, never assumed.)

### 3.3 CorpusDefaults

Per-corpus default behaviors that queries inherit unless they override them.

```
CorpusDefaults {
  decayPolicy           : DecayPolicy               -- default decay rule
  confidenceThreshold   : Number                    -- default confidence floor for queries
  contradictionPolicy   : ContradictionPolicy       -- default write-time policy
  retentionPolicy       : RetentionPolicy           -- when claims are physically removed
  defaultSimilarityFn   : SimilarityFn              -- default for ρ when not specified
  defaultStatus         : Set<Status>               -- default status filter for queries
}
```

These are *defaults*. An individual query MAY override any of them. The purpose is to factor common settings out of query expressions: without defaults, every query would have to redeclare its decay policy, confidence threshold, and contradiction policy.

**`confidenceThreshold` wiring.** This is the read-path wiring of the field's "default confidence floor for queries" role: contradiction-detection expressions (`⊥` within resolve pipelines) carrying no explicit threshold are stamped with this value at expression-build time on the derive path, before serialization, so replayed expressions are deterministic regardless of subsequent changes to the corpus default.

### 3.4 AccessPolicy

An access policy declares who may read, write, subscribe to, and administer a corpus.

```
AccessPolicy {
  reads      : Set<PrincipalPattern>                -- who can read
  writes     : Set<PrincipalPattern>                -- who can write
  subscribes : Set<PrincipalPattern>                -- who can subscribe
  admin      : Set<PrincipalPattern>                -- who can modify policy/schema
  conditions : Set<ConditionalRule>                 -- conditional access (per claim, per scope)
}
```

`PrincipalPattern`s are pluggable: they integrate with an authorization engine (Bedrock, or any other) through the authorization adapter protocol (see §9). The library does not implement RBAC internally; it delegates to the authorization adapter.

The library **MUST** enforce the access policy at every read, write, and subscribe operation. Access denials are themselves auditable events and are written to a designated audit corpus.

---

## 4. Query algebra

The query algebra is the heart of Mneme: a set of composable, typed operators over corpora, each presented with a type signature, an intuition, an equational-law section, and an incremental-evaluation note. This section specifies the retrieval, filtering, and ranking operators — selection (§4.2), projection (§4.3), temporal slicing (§4.4), decay (§4.5), similarity ranking (§4.6), and provenance traversal (§4.7) — under the notation pinned in §0.4. The combination, contradiction, override, join, and composition operators, the optimizer-relevant laws, and the aggregation operators follow in §4.8–§4.14.

### 4.1 Type-signature notation

Each operator is presented with a type signature, an intuition, and an equational-law section, using the operator notation fixed in §0.4. The supporting type names are recalled here:

- `Corpus` denotes a typed collection of claims.
- `RankedCorpus` is a corpus where each claim carries an associated score (typically a similarity score).
- `ComposedContext` is a token-budgeted, formatted document ready for LLM input; it is a *terminal* type — the algebra ends when composition produces it.

The retrieval operators in §4.2–§4.7 all have signature `Corpus → Corpus` except similarity ranking, which has signature `Corpus → RankedCorpus`. Because most retrieval operators preserve the `Corpus` type, they compose freely; the equational laws below state when that composition commutes or simplifies, which is what an optimizer (§4.14) exploits.

Every operator carries an **incremental-evaluation note** classifying its cost under a streaming workload — whether the operator can be maintained in `O(1)` or `O(log n)` per write (*streamable*) or requires re-evaluation (*non-streamable*). The subscription model (§8) consumes this classification directly.

### 4.2 Selection — σ `[C]`

```
σ_p : Corpus → Corpus
```

Filter the corpus to the claims matching predicate `p`. Selection is the workhorse of the algebra — most queries are mostly selection. The predicate language is composable and includes:

- **Relational predicates** — `key = X`, `subject ∈ S`, `scope.entityId = Y`.
- **Probabilistic predicates** — `confidence > 0.7`, evaluated using a configurable point estimator over the confidence distribution (the Beta effective mean of §2.4 by default).
- **Temporal predicates** — `valid-at(D)`, `recorded-after(T)` (see also the τ operator, §4.4).
- **Tag predicates** — `tag ∈ T`, `tag ⊇ S` (set containment).
- **Status predicates** — `status = validated`, `status ∈ {validated, provisional}`.
- **Value predicates** — predicates against the `value` field and paths within it (specified below).
- **Compound predicates** — `p₁ ∧ p₂`, `p₁ ∨ p₂`, `¬p`; predicates compose via the boolean operators.

#### 4.2.1 Value predicates

The corpus schema (§3.2) declares `valueSchemas`, and the implicit promise of a declared value schema is that values can be queried per their declared structure. The selection language therefore includes value predicates against the `value` field, in two forms — path predicates that address a location *within* the value, and whole-value predicates that match the value as a unit:

```
-- Value path predicates
σ_{value.path = X}                  -- equality on a path within the value
σ_{value.path > X}                  -- comparison (gt, gte, lt, lte)
σ_{value.path ∈ S}                  -- set membership
σ_{value.path matches regex}        -- regex match on string-valued paths
σ_{value.path is null}              -- null check
σ_{value.path exists}               -- path-existence check

-- Whole-value predicates
σ_{value = X}                       -- equality for primitive-valued claims
σ_{value matches pattern}           -- structural pattern match
```

**Path syntax.** Paths follow JSON-path conventions: dotted access (`value.amount.currency`), array indexing (`value.items[0]`), and wildcard array (`value.items[*]`). **Recursive wildcards are NOT supported** — a path addresses a bounded, statically-knowable set of locations.

**Parse-time type checking.** When the corpus declares a value schema for the key, the library **MUST** perform parse-time type checking of the predicate against that schema and **MUST** reject predicates that:

- reference fields not present in the schema,
- compare incompatible types, or
- use enum values not in the declared enum.

When no schema is declared for the key, value predicates are *dynamically typed*. A runtime type mismatch produces a typed error — never a silent empty result. (This mirrors the rule for non-value field references in §3.2: a missing field is a query-time error, not silence.)

**Adapter support.** Value-predicate support is a per-`(adapter, predicate-kind)` capability — different predicate kinds (equality, range, set-membership, regex, structural pattern, null-check) have different indexing characteristics even within one adapter, and the optimizer chooses an evaluation strategy per kind. The adapter-capability matrix and the optimizer's per-kind strategy (push-down to a native index, push-down as a scan, in-memory fallback, or parse-time rejection) are specified with the storage adapter protocol in §10.

**Equational laws.**

- Commutativity: `σ_{p₁}(σ_{p₂}(C)) = σ_{p₂}(σ_{p₁}(C))`.
- Conjunction split: `σ_{p₁ ∧ p₂}(C) = σ_{p₁}(σ_{p₂}(C))`.
- Value predicates compose with the rest of the predicate language and respect these laws: commutativity with other selections holds when the addressed paths are unambiguous, and push-down through joins, temporal slicing, and decay holds for value predicates that do not reference those operators' fields (see §4.14).

**Incremental evaluation.** Streamable. For a new write, check whether the new claim matches `p`; if so, add it to the result. On a deletion (deprecation), remove the claim if it had previously matched. Value-predicate matching is per-claim and so does not change this classification; only its *cost* per write varies by adapter capability (§10).

### 4.3 Projection — π `[C]`

```
π_f : Corpus → Corpus
```

Restrict each claim to the subset of fields specified by `f`. The result is still a corpus, but with thinner claims (some fields elided). Projection is used primarily for token efficiency in composition: when the consumer does not need full claims, projecting early reduces the data flowing through the rest of the pipeline.

**Equational laws.**

- Idempotence: `π_f(π_f(C)) = π_f(C)`.
- Composition: `π_f(π_g(C)) = π_{f ∩ g}(C)` when `f ⊆ g`. Adjacent projections combine into a single projection over the intersection of their field sets (see §4.14).

**Incremental evaluation.** Streamable. Each new write is projected independently.

### 4.4 Temporal slicing — τ `[C]`

Bitemporal time-travel over the two time dimensions of §2.6 (valid-time and recorded-time). There are three variants, one for each bitemporal question, plus a shorthand for the present:

```
τ_valid(T)    : Corpus → Corpus
τ_recorded(T) : Corpus → Corpus
τ_known(T)    : Corpus → Corpus
```

- **`τ_valid(T)`** — restrict to claims whose valid-time interval covers `T`. Answers *"what was true about the world at T."*
- **`τ_recorded(T)`** — restrict to claims with `recorded ≤ T`. Answers *"what had been written to the corpus by T."*
- **`τ_known(T)`** — restrict to claims where both the valid-time interval covers `T` *and* `recorded ≤ T`. Answers *"what would the system have computed if asked at T about T."*

**`τ_now`** is shorthand for `τ_known(currentInstant())`. Most queries against the present SHOULD use `τ_now`. Time-traveling queries SHOULD use `τ_known(T)` for the standard "what did we know then" question; the other two variants are for specialized needs — auditing historical writes (`τ_recorded`) or revising a retrospective view as late-arriving claims land (`τ_valid`).

**Equational laws.**

- `τ_valid(T)` and `σ_p` commute when `p` does not reference valid-time.
- `τ_recorded(T)` and `σ_p` commute when `p` does not reference recorded-time.
- `τ_known(T) = τ_valid(T) ∘ τ_recorded(T)` — the bitemporal slice is the composition of the two single-dimension slices.

**Incremental evaluation.** For `τ_recorded(T)` with `T ≤ now`, the result is *stable*: no new write can be `recorded` at or before a past `T`, so the slice never changes. For `τ_now` the result evolves, and the library re-evaluates incrementally on each commit (the new claim enters the slice iff its valid-time covers the advancing clock).

### 4.5 Decay — δ `[C]`

```
δ_policy : Corpus → Corpus
```

Apply a time-based confidence adjustment per `policy`. A decay policy is a function from `(recorded, current, source)` to a confidence multiplier in `[0, 1]`. Decay does **NOT** mutate the underlying stored confidence; it produces a new corpus in which each claim's *effective* confidence reflects the decay. Subsequent operators that reference confidence (e.g. `σ_{confidence > 0.7}`) see the effective values. This is the operational meaning of "effective confidence is computed at query time, not at write time" (§2.4).

Standard policies:

- **`δ_none`** — no decay; the identity transformation.
- **`δ_exponential(half_life)`** — exponential decay with the given half-life.
- **`δ_linear(rate)`** — linear decay at `rate` per day.
- **`δ_step(threshold)`** — full confidence until the claim reaches `threshold` age, then zero.

Per-source default half-lives for `δ_exponential` are tabulated in Appendix A; corpora MAY override them per schema, and an individual query MAY override the corpus default (§3.3).

**Equational laws.**

- `δ_pol(σ_p(C)) = σ_p(δ_pol(C))` when `p` does not reference confidence — decay and a confidence-independent selection commute.
- `δ_{pol₁}(δ_{pol₂}(C))` is in general **NOT** equal to `δ_{pol₁ ∘ pol₂}(C)`. Decay is not freely composable: applying two decay policies in sequence is not the same as applying their functional composition, because each policy reads the *current* effective confidence rather than the raw stored value.

**Incremental evaluation.** Streamable. Each new claim has decay applied based on its own `recorded` time and the current time, independently of the other claims.

### 4.6 Similarity ranking — ρ `[C]`

```
ρ_{sim, q} : Corpus → RankedCorpus
```

Score each claim by its similarity to a query value `q` under similarity function `sim`. The output is the input corpus annotated with a similarity score per claim — i.e. a `RankedCorpus`. Similarity ranking is the one retrieval operator that changes the corpus type.

Similarity functions are pluggable through the `SimilarityFn` protocol `[P]`:

```
SimilarityFn {
  scoreOne(claim: Claim, query: Value) → Number        -- 0..1 similarity
  scoreBatch(claims: Set<Claim>, query: Value) → Map<ClaimId, Number>
  isPure : Bool                                          -- deterministic given the same inputs?
  cost   : CostHint                                      -- O(1), O(log n), O(n), …
}
```

`isPure` declares whether the function is deterministic given the same inputs (which governs cacheability and replay), and `cost` is a hint the optimizer uses when ordering operators. A similarity function is registered per corpus in the schema's `similarities` map (§3.2), and the corpus's `defaultSimilarityFn` (§3.3) is used for ρ when none is named.

Standard similarity functions (full input-type and cost table in Appendix B):

- **`sim_cosine`** — vector cosine over embeddings (requires an embedding adapter).
- **`sim_jaccard`** — Jaccard over token sets.
- **`sim_bm25`** — BM25 over text content.
- **`sim_exact`** — exact match (returns `1.0` or `0.0`).
- **`sim_structural`** — domain-specific structural matching for typed value schemas.

Because `ρ_cosine` (and any embedding-based function) depends on the embedding model in use, a derived write whose query references a similarity-based operator MUST capture the similarity-function and embedding-model versions in derivation provenance (§2.7); replay is conditional on those versions remaining available (§6).

**Composition at the `SimilarityFn` level.** Similarity functions compose at the `SimilarityFn` level: a combinator such as `hybrid-max` is itself a `SimilarityFn` whose score is the maximum of its component scores and whose `isPure` is the conjunction of its components' `isPure` flags. Combinators carry machine-generated version strings (e.g. `hybrid-max@1[jaccard@1,cosine@1]`) that are recorded in `similarityVersions` in derivation provenance (§2.7). Embedding-model identity is recorded SEPARATELY in `embeddingModelVersions` (also §2.7) — version strings in `similarityVersions` are math-only identifiers that do not embed the model name. This separation means that if the underlying embedding model changes (e.g. a model upgrade), the similarity-function version string is unchanged but a new `embeddingModelVersions` entry is recorded; the replay machinery (§7) surfaces the drift through the embedding-version check, not through the similarity-function-version check. Version strings stay math-only so that model drift surfaces exclusively through the embedding-version replay check.

**Equational laws.**

- Monotonicity under selection: `ρ_{sim,q}(σ_p(C))` produces a subset of the rankings of `ρ_{sim,q}(C)` — filtering before ranking yields a subset of the ranking obtained after filtering. (This is the basis for hoisting similarity to after selection in §4.14.)
- Idempotence: `ρ_{sim,q}(ρ_{sim,q}(C))` is well-defined but typically redundant; the second application is a no-op when scores are stored.

**Incremental evaluation.** **Not streamable** in the general case: a new claim may score higher than the current top-K and shift the ranking. For small `K` the library can maintain a sorted structure efficiently; for large `K`, full re-ranking is expensive. Subscriptions over ρ should be used with caution (see §8).

### 4.7 Provenance traversal — γ `[C]`

```
γ_d : Corpus → Corpus
```

For each claim in the input corpus, follow evidence edges to depth `d`, returning the transitive closure of cited claims. The traversal walks the evidence DAG of §2.8; acyclicity guarantees the closure is finite and that traversal terminates.

- `γ_0(C) = C` — depth zero is the identity.
- `γ_1(C)` includes `C` plus all directly-cited claims.
- `γ_∞(C)` includes the full provenance graph reachable from `C`.

The result is a corpus containing both the original claims and their evidence-graph ancestors, with no duplication.

**Equational laws.**

- Monotonicity: `C ⊆ γ_d(C)` for all `d ≥ 0` — traversal only ever adds claims.
- Composition: `γ_{d₁}(γ_{d₂}(C)) = γ_{d₁ + d₂}(C)` — composing two bounded traversals is a single traversal to the summed depth.

**Incremental evaluation.** Streamable for bounded `d` when the evidence-graph index is maintained: a new claim brings its own bounded neighborhood. Unbounded depth (`d = ∞`) is generally expensive to maintain incrementally and SHOULD use lazy evaluation.

### 4.8 Contradiction detection — ⊥ `[C]`

Contradiction detection finds claims that conflict. Unlike the retrieval operators of §4.2–§4.7, the contradiction operators do not return a corpus: their output is a set of *meta-relations* over the corpus. Two representations are provided — a pairwise form and a more general clustered form — together with resolution operators that consume the detected conflicts and produce a new corpus state.

```
⊥_pairs    : Corpus → Set<ContradictionPair>      `[C]`
⊥_clusters : Corpus → Set<ContradictionCluster>   `[C]`
```

`⊥_pairs` is the pairwise form. `⊥_clusters` is the more general n-way form. Both are core-tier.

#### Pairwise contradictions — `⊥_pairs`

`⊥_pairs` finds claim pairs that conflict. Two claims conflict iff:

1. They share `(subject, key, scope)`.
2. They have different `value`s.
3. Both are above the corpus's contradiction confidence threshold.

**Threshold as eligibility dial.** Criterion 3 means `eff(claim) > threshold` — claims at or below the threshold are ineligible to contest and are excluded from contest (no pair or cluster is formed with them). The threshold is an ELIGIBILITY dial, not a resolution policy; it controls which claims are considered live enough to matter. The recommended default is `0` (every claim with nonzero effective confidence contests), which is the most conservative choice — no pair is silently excluded without explicit configuration. When recency and confidence point in opposite directions, there is no universal resolution; the caller's chosen resolution rule IS the policy, and it is the caller's responsibility to select a rule that matches the domain's semantics.

**Multi-valued key exemption.** Keys declared `"multi"` in the schema's `keyCardinality` (§3.2) are excluded from contest entirely (no pair or cluster is formed with them). This exemption is applied at grouping time, before pairs or clusters are constructed: triples whose key maps to `"multi"` are never grouped, and distinct values for those keys are never reported as contradictions. This keeps `⊥` well-defined for heterogeneous corpora where some keys accumulate and others assert.

**Canonical read-side composition.** The recommended ordering when composing a read pipeline is: `τ_valid → ⊕_dedupe (similarity mode) → ⊥ → resolve → drop deprecated/flag artifacts → rank`. Running `⊕_dedupe` in similarity mode before `⊥` prevents near-duplicate restatements from forming spurious contradictions that would otherwise require resolution — restatements merge before the conflict detector sees them, and genuinely distinct dissenting values survive to be detected. This ordering is recommended, not enforced; callers MAY omit `⊕_dedupe` or place it after `⊥` when the corpus structure makes near-duplicate restatements impossible or irrelevant.

The output is the set of pairs, NOT a corpus — contradictions are meta-relations over the corpus.

```
ContradictionPair {
  left           : Claim
  right          : Claim
  conflictReason : ConflictReason                  -- value-difference, status-conflict, …
  resolution     : Resolution?                     -- if a resolution policy was applied
}
```

#### Clustered contradictions — `⊥_clusters`

When multiple claims disagree about the same `(subject, key, scope)` with three or more distinct values, the pair representation produces `N×(N−1)/2` binary pairs that lose the structure of the disagreement: "three sources support A, one supports B, one supports C" is more informative than "seven pairs in conflict." `⊥_clusters` is the cluster-typed representation that captures this structure alongside the pairwise form.

```
ContradictionCluster {
  triple                   : (Subject, Key, Scope)
  valueGroups              : Map<Value, Set<Claim>>
  totalClaims              : Number
  distinctValues           : Number
  agreementRatio           : Number              -- agreementRatio = largest_group_size / total_claims; 1.0 = consensus, 1/k = perfect disagreement among k groups
  highestConfidenceGroup   : Value?              -- value with highest combined confidence
  combinedConfidences      : Map<Value, Confidence>  -- per-value combined confidence
}
```

The cluster captures which sources support which values, the combined confidence per value, and the highest-confidence position.

Pairs are a derived special case: each cluster with exactly two distinct values produces one pair. For a cluster with `k` distinct values, the number of derivable pairs is `k×(k−1)/2` if all pairs are needed, or `k−1` if "consensus vs each minority" is sufficient. Both projections are supported via helper operators, exposed as `derived_pairs`.

#### Resolution operators

Resolution operators consume detected conflicts and produce a new corpus state. The pairwise resolvers operate on the pair set; the cluster-aware resolvers operate on the cluster set.

```
resolve_deprecate_lower  : Set<ContradictionPair> × Corpus → Corpus
resolve_deprecate_older  : Set<ContradictionPair> × Corpus → Corpus
resolve_flag_for_review  : Set<ContradictionPair> × Corpus → Corpus
resolve_keep_both        : Set<ContradictionPair> × Corpus → Corpus
```

- `resolve_deprecate_older` — per pair, the claim with the earlier `valid.from` is deprecated; the claim with the later `valid.from` survives. Recency semantics: the more recently valid assertion wins.

**Tie semantics for pairwise deprecation resolvers.** When `resolve_deprecate_lower` encounters two claims with identical point estimates (the same point-estimate quantity used for selection in §4.9), or when `resolve_deprecate_older` encounters two claims with identical `valid.from` timestamps, the ordering criterion cannot decide; a silent arbitrary pick masquerades as a resolution. Therefore, exact ties MUST NOT cause either claim to be deprecated. Instead, the resolver MUST append one `contradiction.flag` review artifact per tied pair — a candidate-status claim with subject `contradiction` recording both conflicting claim ids (the same artifact `resolve_flag_for_review` emits) — both claims retain their current status unchanged by this resolver invocation, and the emitted artifacts do not participate in pair derivation within that invocation. This pins previously-unspecified behaviour as a specification addition — no existing normative text for these operators is altered. Note that cluster-level tie-break rules (`resolve_deprecate_minority` and `resolve_promote_consensus` largest-group selection) and the §4.9 `⊕` combination-rule tie-breaks are unchanged; the latter are load-bearing for idempotence and associativity. A per-corpus `tieBehavior` override, if ever needed, would belong in CorpusDefaults (§3.3).

```
resolve_deprecate_minority      : Set<ContradictionCluster> × Corpus → Corpus   `[C]`
resolve_promote_consensus       : Set<ContradictionCluster> × Corpus → Corpus   `[C]`
resolve_synthesize_belief       : Set<ContradictionCluster> × Corpus → Corpus   `[C]`
resolve_synthesize_belief_multi : Set<ContradictionCluster> × Corpus → Corpus   `[P]`
```

- `resolve_deprecate_minority` deprecates the minority-position claims, leaving the larger value groups in force.
- `resolve_promote_consensus` deprecates minority-position claims and promotes the consensus value to validated status.
- `resolve_synthesize_belief` `[C]` produces a new derived claim representing the combined belief over a *binary* disagreement (exactly two value groups). It uses the Beta-typed combined confidence via the subjective-logic bridge of §2.5. Because the binary case requires only Beta math, this operator is core-tier and available to all core consumers without protocol-tier dependencies.
- `resolve_synthesize_belief_multi` `[P]` handles clusters with `k > 2` distinct value groups using the Dirichlet generalization (forward-reference §5.3). It is protocol-tier because multi-way belief synthesis requires the Dirichlet protocol implementation. Core-only deployments without the Dirichlet protocol cannot use this operator and must either reduce multi-way clusters to pairwise resolution or pull in the protocol extension.

This core/protocol split keeps the core-tier promise honest: cluster *detection* (`⊥_clusters`) and binary belief synthesis work in core, but multi-way belief synthesis is a protocol-tier capability because it requires Dirichlet math.

**Equational laws.**

- `⊥_pairs(C) ⊆ derived_pairs(⊥_clusters(C))` — pairs are derivable from clusters (this is in fact an equality, but `⊆` is the safe lower-bound statement).
- `⊥_pairs(σ_p(C)) ⊆ ⊥_pairs(C)` — filtering may remove contradiction pairs but cannot create new ones.
- Cluster generation is deterministic given the `(subject, key, scope)` grouping function.
- Selection commutes: `⊥_clusters(σ_p(C))` includes only clusters whose claims are all in `σ_p(C)`.

**Incremental evaluation.** Streamable. A new claim either:

- joins an existing cluster (matches an existing `(subject, key, scope)`, adds to a `valueGroup`);
- starts a new cluster (matches no existing triple); or
- resolves a cluster (if its value matches an existing group, it increases that group's combined confidence; if it deprecates a minority claim, it may collapse the cluster to consensus).

The pairwise form is maintained the same way: a new claim may introduce contradictions only with existing claims sharing its `(subject, key, scope)`, so the search is scoped to that triple. The library maintains per-triple cluster state in subscription state (§8), updated incrementally on each write.

### 4.9 Belief combination — ⊕ `[C]`

Two distinct operators that the v0 algebra previously conflated into one.

```
⊕_dedupe                  : Corpus → Corpus            `[C]`
⊕_synthesize_as<S, K>     : Corpus → Claim             `[C]`
```

**`⊕_dedupe`** — combine claims sharing `(subject, key, scope)` into a single claim using the configured combination rule. The result is a corpus with no within-key duplicates.

**`⊕_synthesize_as<S, K>`** — combine ALL claims in the input corpus into a single new synthesized claim with subject `S` and key `K`. The synthesized claim's evidence is the union of input evidence; its confidence is computed by the combination rule; its scope is derived from the inputs' shared scope fields.

Both operators are parameterized by a *combination rule*. The post-split rule set is:

- `rule_weighted_avg` — trust-weighted averaging of opinions
- `rule_evidence_pooled` — accumulation of the underlying evidence parameters
- `rule_max_mean` — selection by highest point estimate (mean)
- `rule_max_concentration` — selection by highest evidence weight (concentration)
- `rule_dempster` — Dempster's combination rule (orthogonal evidence)

The rule names are referenced here only; their per-distribution math (Beta, Dirichlet, Gaussian, scalar) and convention-correctness derivations are specified in §5.6. The selection rule is split into two: `rule_max_mean` selects by point estimate and `rule_max_concentration` selects by evidence weight. These answer different questions, so consumers MUST choose explicitly; the library MUST NOT default between them.

**Equational laws.**

- `⊕_dedupe` is associative for symmetric rules (`rule_weighted_avg`, `rule_evidence_pooled`).
- `⊕_dedupe` is NOT generally idempotent — repeated application may change confidence depending on the rule's semantics. The averaging and max-selection rules (`rule_weighted_avg`, `rule_max_mean`, `rule_max_concentration`) are idempotent; the evidence-combining rules (`rule_evidence_pooled`, `rule_dempster`) are not. See §5.6 for the idempotence contract.
- `⊕_synthesize_as` has no idempotence — it is a single-shot synthesis.

**Incremental evaluation.** `⊕_dedupe` is streamable (a new claim either merges with an existing key or stands alone). `⊕_synthesize_as` is streamable for monotonic combination rules and non-streamable for others (`rule_dempster`, in particular, can have order-dependent results in edge cases).

#### Similarity-partitioned merge mode (opt-in)

When `⊕_dedupe` is configured with a similarity function and a cutoff, its grouping step is extended: after collecting all claims that share a `(subject, key, scope)` triple, each group is sub-partitioned by single-link clustering over pairwise value similarity ≥ cutoff before merging. Claims whose values are similar enough (similarity ≥ cutoff) are merged into one representative claim; claims with sufficiently dissimilar values form separate merge groups and survive as distinct claims in the output corpus. This makes `⊕_dedupe` safe to apply before `⊥` (see §4.8 canonical pipeline note): restatements merge, dissimilar values survive to be detected as contradictions.

When the similarity function or cutoff is omitted, `⊕_dedupe` uses whole-group semantics — all claims sharing the triple are merged — exactly as specified above. The similarity-partitioned mode is a strict extension; omitting its configuration produces the base semantics verbatim.

**Determinism.** Within each similarity cluster, members are processed in lexicographic claim-id order to guarantee a deterministic merge sequence. The representative claim for a merged group carries the value and identity (including `id`) of the member with the latest `valid.from`; when two members share the same `valid.from`, the lexicographically larger `id` breaks the tie. Confidence is combined by the configured combination rule applied in the same lexicographic order.

**Scope of equational laws.** The associativity law ("⊕_dedupe is associative for symmetric rules") and the streamable incremental-evaluation characterization stated above apply to the base whole-group mode only. In similarity-partitioned mode the partition depends on the full input set — single-link clusters form over pairwise similarity across all claims in a triple group — so associativity does not hold: splitting the input and recombining can bridge or miss clusters that would form over the complete group. In addition, each new claim requires pairwise comparison within its triple group (O(n)) with possible cascading cluster merges, so evaluation is not streamable in constant work per claim.

### 4.10 Layered override — ⊳ `[C]`

```
⊳ : Corpus × Corpus → Corpus                          `[C]`
```

`C₁ ⊳ C₂` produces a corpus where C₁'s claims take precedence over C₂'s on matching `(subject, key, scope)` triples, but C₂ contributes claims about triples C₁ doesn't address.

This is the layered-merge semantic. Think of it as typed object-spread: `{...defaults, ...specifics}` where keys from `specifics` win.

For the operator to be well-defined, both inputs must be coherent (no within-input contradictions on the same triple). Callers SHOULD apply `⊕_dedupe` to each input before composing with ⊳.

**Equational laws.**

- Associativity: `(C₁ ⊳ C₂) ⊳ C₃ = C₁ ⊳ (C₂ ⊳ C₃)`.
- Identity: `C ⊳ ∅ = C` and `∅ ⊳ C = C`.
- NOT commutative: `C₁ ⊳ C₂ ≠ C₂ ⊳ C₁` in general.

**Incremental evaluation.** Streamable when inputs are stable: the dominator's writes immediately override; the dominated's writes are admitted only when no matching triple exists in the dominator.

### 4.11 Join — ⋈ `[C]`

```
⋈_r : Corpus × Corpus → Corpus                        `[C]`
```

Combine claims from two corpora via relation `r`. Specialized variants:

- `⋈_scope` — claims about the same scope-entity (join on `scope.entityId`)
- `⋈_evidence` — claims linked through evidence references
- `⋈_subject` — claims about the same subject

General relational joins are supported but rarely used in practice — most queries use the specialized variants.

**Equational laws.**

- Commutativity: `C₁ ⋈_r C₂ = C₂ ⋈_r C₁` for symmetric `r`.
- Associativity: `(C₁ ⋈_r C₂) ⋈_r C₃ = C₁ ⋈_r (C₂ ⋈_r C₃)` for symmetric `r`.
- Selection push-down: `σ_p(C₁ ⋈_r C₂) = σ_p(C₁) ⋈_r C₂` when `p` only references C₁'s fields.

**Incremental evaluation.** Streamable for indexed joins; expensive for arbitrary relations.

### 4.12 Composition — κ (and its component operators) `[C]`

The composition operator is split into three component operators that compose, plus a convenience operator for the common case.

```
δ_dedup_content : RankedCorpus → RankedCorpus                         `[C]`
φ_format        : RankedCorpus → ComposedContext                     `[C]`  (parameterized by format)
β_budget        : ComposedContext × TokenBudget → ComposedContext    `[C]`
κ               : RankedCorpus × Format × TokenBudget → ComposedContext  `[C]`  (convenience)
```

**`δ_dedup_content`** — remove near-duplicate content from a ranked corpus using a content-similarity threshold (Jaccard, cosine, etc.).

**`φ_format`** — produce a formatted document from a ranked corpus. Supported formats: XML, Markdown, JSON, plain text.

**`β_budget`** — truncate a composed document to a token budget, keeping highest-ranked content.

**`κ`** — convenience composition that applies dedup, format, and budget in sequence.

`ComposedContext` is *not* a corpus. It is a terminal type — the algebra ends when composition produces it. Composition is a lossy, ordered, formatted output ready for an LLM context window.

**Equational laws.**

- Composition: `κ ≡ β_budget ∘ φ_format ∘ δ_dedup_content` (up to parameterization).
- NOT streamable — composition is order-sensitive and budget-sensitive in ways that fight incremental evaluation. Re-evaluation on each write is the safe semantics.

### 4.13 Aggregation operators — α `[C]`

The retrieval and combination operators of §4.2–§4.12 cannot compute aggregates over claim sets — count, group-by, sum, rate. Outcome-correlated reweighting, listed as a first-class need, cannot be expressed without them. The aggregation family closes this gap. It is core-tier.

Aggregation introduces a second terminal type alongside `Corpus` and `ComposedContext`:

```
AggregateResult {
  groups : Map<GroupKey, AggValue>
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
  | rate(beta: Beta)                  -- emits a Beta, NOT a raw ratio
  | distribution(samples: List<Number>)
  | custom(value: any, fn: AggregateFunction)
```

`AggregateResult` is a typed structured value that can be consumed by reweighting operators, used directly by application code, or composed with other aggregates.

The `rate` variant emits a `Beta` distribution rather than a raw numerator/denominator ratio. A raw ratio discards sample-size uncertainty: 22/30 wins and 1/1 wins compute to 0.73 and 1.0 respectively, but the second is overwhelmingly noisier and should not outrank the first. Emitting a Beta parameterized by the underlying counts lets downstream reweighting use the Beta's mean, its Wilson lower bound, or any other confidence-aware scoring — composing cleanly with the distribution machinery of §2.5 and §5.

#### The operators

```
α_count       : Corpus → AggregateResult                       `[C]`
α_count_where<predicate> : Corpus → AggregateResult            `[C]`

α_sum<value-path> : Corpus → AggregateResult                   `[C]`
α_avg<value-path> : Corpus → AggregateResult                   `[C]`
α_min<value-path> : Corpus → AggregateResult                   `[C]`
α_max<value-path> : Corpus → AggregateResult                   `[C]`

α_groupBy<group-field, aggregator> : Corpus → AggregateResult  `[C]`

-- Primary rate form: explicit numerator and denominator predicates
α_rate<num-predicate, denom-predicate> : Corpus → AggregateResult  `[C]`

-- Convenience for binary outcome domains
α_binary_rate<value-path> : Corpus → AggregateResult           `[C]`

α_custom<fn> : Corpus → AggregateResult                        `[C]`
```

The `<group-field>` parameter is a field path (`scope.actionId`, `scope.entityId`, `value.category`). The `<aggregator>` is one of the simple aggregate operators or a custom function.

`α_rate<num, denom>` takes two predicates explicitly. The numerator counts claims matching `num-predicate`; the denominator counts claims matching `denom-predicate`. This is the primary form because real outcome domains often include unresolved states (`pending`, `null`, `cancelled`) that should not count as failures.

`α_binary_rate<value-path>` is sugar for `α_rate<num: value-path = true, denom: value-path = true ∨ value-path = false>`. It excludes null/pending/unresolved states from both numerator and denominator. Use this when the outcome domain is strictly binary and unresolved values should be ignored.

#### The Beta-typed rate

Both rate forms emit a Beta distribution parameterized by the corpus's pinned non-informative prior weight `W` and base rate `a` (§0.3). For `r` positive observations (matching the numerator predicate) and `s` negative observations (matching the denominator-but-not-numerator predicate), the emitted Beta is:

```
Beta(α=r+a·W, β=s+(1−a)·W)
```

This uses the pinned α, β convention of §0.3, so it composes cleanly with the subjective-logic bridge of §2.5 — the same convention applies. This is NOT Laplace smoothing (`+1/+1`); it uses the corpus's declared prior. Consumers can extract:

- **Mean** — the standard Beta mean, for a point estimate.
- **Wilson lower bound** — a confidence-aware floor that penalizes small samples.
- **Full distribution** — for downstream uncertainty propagation.

#### The bridge operator

The bridge from `AggregateResult` back to `RankedCorpus` lets an aggregate reweight a ranked retrieval:

```
α_join_aggregate<corpus-field, aggregate-key, reweight-fn> :
  RankedCorpus × AggregateResult → RankedCorpus                `[C]`
```

For each claim in the `RankedCorpus`, look up the matching aggregate value by the join key, then apply the reweight function to adjust the claim's score.

Standard reweight functions:

```
reweight_multiply         : score × aggregate_value          -- when aggregate is in [0,1]
reweight_multiply_mean    : score × mean(aggregate_beta)     -- for Beta aggregates
reweight_wilson_floor     : score × wilson_lower_bound(beta) -- confidence-aware
reweight_boost(factor)    : score + (aggregate_value × factor)
reweight_normalize        : aggregate_value / max(all_aggregates)
reweight_custom(fn)       : user-defined
```

`reweight_multiply_mean` and `reweight_wilson_floor` are specifically for Beta-typed aggregates, addressing the sample-size sensitivity that a raw ratio would ignore.

#### Worked example: win-rate reweighting

The pressure-test query that the retrieval-only algebra could not express, now expressed correctly:

```
let actions  = σ_subject="action" ∧ key="action.recommended" (corpus("sales-app"))
let outcomes = σ_subject="action" ∧ key="action.outcome"     (corpus("sales-app"))

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

The action with 22/30 wins (Wilson lower bound ≈ 0.55) correctly outranks the action with 1/1 win (Wilson lower bound ≈ 0.21 at 95% confidence). Sample size is respected: even though 1/1 has a higher point estimate (1.0 > 0.73), the Wilson lower bound penalizes the small sample, and the well-evidenced 22/30 action wins. The aggregation family composes with the distribution family.

If the outcome domain had three values (`won`, `lost`, `pending`) and the denominator needed to be controlled explicitly:

```
let win_betas = α_groupBy<scope.actionId,
                          rate<num: value.won = true,
                               denom: value.won = true ∨ value.won = false>>(outcomes)
```

This excludes pending outcomes from both numerator and denominator — they do not count as losses, but they also do not dilute the rate.

**Equational laws.**

- `α_count(σ_p(C)) = α_count_where<p>(C)` — pre-filtering equals filtered aggregation.
- Selection generally commutes through aggregation when the predicate does not reference aggregate values.

Aggregation operators do NOT have a closed-form composition with each other. Aggregate results are not corpora, so the type signatures do not match. Composing aggregations requires either an explicit aggregate-to-corpus conversion (deferred, §G) or expressing the composition as a single multi-level `α_groupBy` with appropriate group keys.

**Incremental evaluation.** Aggregation operators are conditionally streamable:

- `α_count`, `α_sum`, `α_avg`, `α_rate` are streamable — each write contributes to running totals.
- `α_min`, `α_max` are streamable for additions but require a re-scan for deletions.
- `α_groupBy` is streamable when the group-field is stable per claim.
- `α_custom` depends on the function — consumers declare streamability via the `AggregateFunction` protocol.

For subscriptions (§8), queries that include aggregation must be over streamable aggregates, or pay re-evaluation cost on each corpus change.

**Storage adapter support.** Aggregation translates well to SQL adapters (`GROUP BY`, `COUNT`, `SUM` are native). Vector DBs typically lack aggregation; the library falls back to retrieving the candidate set and aggregating in memory. For high-cardinality `α_groupBy` operations the library provides cardinality hints to consumers and refuses pathologically expensive queries.

### 4.14 Optimizer-relevant laws

The algebra's equational laws enable a query optimizer. Key rewrite rules:

- **Push selection down**: apply `σ` as early as possible to shrink working sets before more expensive operators run.
- **Push temporal slicing down**: apply `τ` before other operators when valid-time and recorded-time semantics permit, so downstream operators see only the relevant time window.
- **Push decay before confidence filters**: when a query filters by effective confidence, apply `δ` first so the filter sees decayed values.
- **Hoist similarity to after selection**: apply `σ` before `ρ` so the corpus is filtered before ranking, avoiding expensive similarity computations on claims that are filtered out (the monotonicity-under-selection law of §4.7 justifies this).
- **Combine adjacent projections**: `π_f ∘ π_g = π_{f ∩ g}` — adjacent projections collapse into a single projection over the intersection of their field sets.
- **Memoize stable subqueries**: subqueries against stable temporal slices — e.g. `τ_recorded(past)` slices, whose recorded-time window lies wholly in the past and can no longer change — can be cached and reused across queries.

**Dempster combinations are freely reorderable.** Dempster's rule of combination is unconditionally commutative AND associative: `m₁ ⊕ m₂ = m₂ ⊕ m₁` and `(m₁ ⊕ m₂) ⊕ m₃ = m₁ ⊕ (m₂ ⊕ m₃)` for all mass functions, with the vacuous mass function as identity. The optimizer may therefore group and reorder a chain of Dempster combinations in any order without changing semantics. High-conflict inputs (Zadeh's paradox) can produce counterintuitive results, but that is a property of the rule itself, not a breakdown of associativity, so it places no ordering constraint on the optimizer. Dempster's rule is, however, *not* idempotent (`m ⊕ m ≠ m`), so the optimizer must not introduce or drop duplicate combination inputs when reordering.

The optimizer is a separate component from the algebra. The algebra defines what rewrites are *legal* — the equational laws above and in §4.2–§4.13; the optimizer chooses among legal evaluation orders on cost grounds. An optimizer is never required for correctness, and no rewrite it performs may change a query's result.

## 5. Distribution protocol [P]

Confidence (§2.4) is a distribution, not a point estimate. The query algebra of §4 is generic over the distribution type: operators that touch confidence — decay δ (§4.5), belief combination ⊕ (§4.9), contradiction resolution (§4.8), aggregation α (§4.13) — never branch on whether they hold a Beta, scalar, Dirichlet, Gaussian, or consumer-defined distribution. They call protocol operations, and the registered implementation supplies the type-specific math.

This tiering is deliberate. The Beta and scalar bindings are core `[C]`: every Mneme implementation MUST provide them, because the core types and the worked examples of §2.4–§2.5 depend on them. The remaining bindings are protocol-tier `[P]`: Dirichlet (multi-category beliefs, §5.3), Gaussian (continuous measurements, §5.4), and Kalman fusion are *vertical-specific math*, supplied as reference implementations rather than core obligations. A consumer in a subjective-logic decision domain needs Dirichlet; a consumer in a sensor/measurement domain needs Gaussian and Kalman; a pure-orchestration consumer needs neither. Pushing them behind the protocol narrows core's correctness surface: an implementation that only supports `beta` and `scalar` is not obligated to get Dirichlet or Gaussian correctness right, and an implementation that needs them pulls in a reference binding or registers its own.

The protocol is the single seam between the algebra and distribution-specific math. The per-rule combination semantics referenced throughout §4 (`rule_weighted_avg`, `rule_evidence_pooled`, `rule_max_mean`, `rule_max_concentration`, `rule_dempster`) are dispatched through this protocol and specified per distribution in §5.6.

### 5.1 The protocol interface

A distribution binding is a `DistributionProtocol<T>` over the implementation's parameter type `T` (for Beta, `T = {alpha, beta}`; for scalar, a point value; for Dirichlet, a parameter vector). The library registers one binding per `DistributionType` and dispatches uniformly.

```
DistributionProtocol<T> {
  -- Serialization
  serialize(d: T) → bytes
  deserialize(b: bytes) → T
  canonicalize(d: T) → bytes              -- stable byte form for hashing in derivation provenance (§2.7)

  -- Statistics
  mean(d: T) → Number
  variance(d: T) → Number
  pdf(d: T, x: any) → Number              -- optional; MAY throw NotImplemented

  -- Conversion (for mixed-distribution combination)
  to_subjective_logic_opinion(d: T) → SLOpinion?    -- optional; required for rule_dempster
  from_subjective_logic_opinion(o: SLOpinion) → T?  -- optional

  -- Combination
  combine(rule_id: string, a: T, b: T, params: any) → T
  supported_rules() → Set<string>          -- which rule_ids this binding implements
  is_idempotent(rule_id: string) → Bool    -- per-rule idempotence flag
}
```

**Serialization.** `serialize`/`deserialize` round-trip the parameters for storage. `canonicalize` produces a stable, order-independent byte form used when hashing a derived claim's inputs into its provenance (§2.7); two parameter values that are equal as distributions MUST canonicalize to identical bytes so that derivation hashes are reproducible.

**Statistics.** `mean` is the distribution's point estimate — the value the δ operator (§4.5) and the `rule_max_mean` selection (§4.9) read. `variance` backs `rule_max_concentration` (lower variance = higher concentration = more evidence) and precision-weighted fusion. `pdf` is optional because not every binding has a closed-form density a consumer needs; a binding MAY throw `NotImplemented`.

**Conversion hooks are optional.** `to_subjective_logic_opinion` / `from_subjective_logic_opinion` exist for mixed-distribution combination (§5.5) and for `rule_dempster`, which is defined on subjective-logic mass functions. A binding that does not support Dempster combination MAY omit them (return absent); the library MUST NOT assume their presence and MUST surface a clear error when a rule that needs a conversion is requested against a binding that lacks it.

**Combination and capability declaration.** `combine(rule_id, a, b, params)` performs the type-specific combination for `rule_id`. `supported_rules()` declares which `rule_id`s the binding implements, so the library can reject an unsupported combination before attempting it rather than failing mid-evaluation. `is_idempotent(rule_id)` reports whether `combine(rule_id, x, x, params) = x`; callers consult it to decide whether deduplication is required before combining (a non-idempotent rule such as `rule_kalman` or `rule_evidence_pooled` demands observation-level dedupe; an idempotent rule such as `rule_weighted_avg` does not). `is_idempotent` MUST agree with the idempotence contract that the equational laws of §4.9 depend on, and is specified per rule in §5.6.

### 5.2 Beta and scalar reference binding `[C]`

The Beta and scalar bindings are core. They are the bindings the worked examples and the subjective-logic bridge of §2.4–§2.5 are written against, and every Mneme implementation MUST provide them.

**Beta.** `T = {alpha, beta}` under the `α = r + a·W`, `β = s + (1−a)·W` convention pinned in §0.3.

- `mean(d) = α/(α+β)` — the Beta effective mean. This is the projected probability of the corresponding subjective-logic opinion; the binding MUST NOT diverge from the effective-mean and bridge formulas given in §2.4–§2.5, which are the normative source for the Beta/SL math (not restated here).
- `variance(d) = αβ / ((α+β)²·(α+β+1))` — backs `rule_max_concentration`, where total concentration `α+β` orders the inputs.
- `to_subjective_logic_opinion` / `from_subjective_logic_opinion` implement the binomial bridge of §2.5 (`belief = (α−a·W)/(α+β)`, `uncertainty = W/(α+β)`, `base_rate = a`) and its inverse. These enable `rule_dempster` for Beta inputs.
- `combine(rule_id, a, b, params)` dispatches to the per-rule Beta math specified in §5.6. `supported_rules()` returns all five core rules: `rule_weighted_avg`, `rule_evidence_pooled`, `rule_max_mean`, `rule_max_concentration`, `rule_dempster`.
- `is_idempotent`: true for `rule_weighted_avg`, `rule_max_mean`, `rule_max_concentration`; false for `rule_evidence_pooled` and `rule_dempster`. This is the contract the §4.9 equational laws rely on; the per-rule derivations are in §5.6.

**Scalar.** `T` is a bare point value `p ∈ [0,1]` — a confidence with `distribution = scalar` (§2.4), carrying no evidence weight.

- `mean(d) = p`; `variance(d) = 0` (a point mass carries no spread); `pdf` throws `NotImplemented` (a point mass has no proper density).
- `to_subjective_logic_opinion` is absent unless the consumer supplies an explicit pseudocount to lift the scalar into a Beta first (per §5.5); a bare scalar has no evidence total and therefore no well-defined opinion. The library MUST NOT silently fabricate a pseudocount.
- `supported_rules()` returns the rules that are well-defined without evidence weights: `rule_weighted_avg` (weighted average of the point values, with weights from `params`), `rule_max_mean`, and `rule_max_concentration` (degenerate — all scalars share variance 0, so concentration ties break by claim ID, per §4.9). `rule_evidence_pooled` and `rule_dempster` are NOT supported: both require an evidence total a bare scalar lacks. The per-rule scalar math is in §5.6.
- `is_idempotent`: true for every rule the scalar binding supports — `rule_weighted_avg`, `rule_max_mean`, `rule_max_concentration` are all idempotent on point values.

### 5.3 Dirichlet reference binding `[P]`

Dirichlet generalizes Beta from a binary frame to `k` categories. It is the protocol-tier `[P]` binding for multi-category beliefs — a consumer in a subjective-logic decision domain over a categorical frame `{x₁, …, xₖ}` registers it; core implementations are not obligated to provide it. `T` is the parameter vector `(α₁, …, αₖ)`, each `αᵢ = rᵢ + aᵢ·W` under the prior-inclusive convention pinned in §0.3, with per-category base rates `a₁, …, aₖ` (Σaᵢ = 1) and non-informative prior weight `W`.

**Statistics.** With total concentration `S = Σⱼ αⱼ`:

```
mean(d)[i]     = αᵢ / S                          -- per-category projected probability
variance(d)[i] = αᵢ(S − αᵢ) / (S²·(S + 1))       -- per-category marginal variance
```

Each category's marginal is a Beta(`αᵢ`, `S − αᵢ`), so `mean`/`variance` reduce to the Beta formulas of §5.2 on that marginal. `mean(d)` returns the point-estimate vector; for the scalar `mean(d) → Number` the binding returns the highest-category projected probability (the mode's mean), which is the value `rule_max_mean` reads. `variance(d)` backs `rule_max_concentration` via `S`: higher `S` is lower per-category variance is more evidence.

**Marginalization.** A Dirichlet marginalizes by summing parameters of the collapsed categories: collapsing `{xᵢ, xⱼ}` into a single category yields parameter `αᵢ + αⱼ`, and the result is a valid Dirichlet over the coarser frame (Beta when the frame collapses to two categories). The binding exposes this so that a consumer can query a belief over a sub-partition of the frame without re-fitting; `S` and base rates aggregate the same way.

**SL bridge.** The Dirichlet ↔ subjective-logic multinomial-opinion bridge is normative in §2.5 (`belief(xᵢ) = (αᵢ − aᵢW)/S`, `uncertainty = W/S`, `base_rate(xᵢ) = aᵢ`, `projected(xᵢ) = αᵢ/S`) and is not restated here. `to_subjective_logic_opinion` / `from_subjective_logic_opinion` implement that bridge and its inverse, which is what enables `rule_dempster` for Dirichlet inputs (via the mass-function conversion of §2.5). The vacuous case `Dirichlet(W·a₁, …, W·aₖ)` yields zero belief on every singleton and full uncertainty, as §2.5 records.

**Note on W scaling for larger frames.** The `W = 2` default is tuned for binary frames; for `k > 2` the per-category prior weight under the symmetric base rate `aᵢ = 1/k` is `W/k` — e.g. `W = 2, k = 5` gives each category a prior weight of `0.4`, a very weak prior. Consumers using large frames should consider scaling `W` with frame size (Jøsang's literature uses both `W = 2` constant and `W = k`); the corpus schema MAY override `W` per-key for multi-category value schemas. Absent an override, `W = 2` applies regardless of `k`, with prior strength diminishing per category as the frame grows.

**Combination rules.** `combine(rule_id, a, b, params)` dispatches to the per-rule Dirichlet math specified in §5.6 (not derived here). `supported_rules()` returns all five rules, with the rule names pinned in §4.9. The per-rule semantics and their idempotence flags:

- `rule_weighted_avg` — trust-weighted average of the parameter vectors, weights from `params` (the source-trust weights of §4.9). **Idempotent ✓**: averaging a vector with itself returns the vector.
- `rule_evidence_pooled` — sum of the parameter vectors with **prior-W subtraction** to avoid double-counting the shared prior: the pooled vector adds the per-category evidence counts `rᵢ = αᵢ − aᵢ·W` and re-applies a single prior, rather than naively summing `αᵢ` (which would count `W` once per input). **Non-idempotent ✗**: pooling a vector with itself accumulates evidence and inflates `S`, so consumers MUST deduplicate by `observation_id` before pooling (§5.1).
- `rule_max_mean` — argmax over the per-category mean: selects the input whose most-likely category has the highest mean across all inputs (tie-broken by claim ID, including the cross-category tie where two inputs share a top-category mean on *different* categories). **Idempotent ✓.**
- `rule_max_concentration` — argmax over total concentration `Σαᵢ` (= `S`): the most-informed opinion — the one with the most evidence backing — wins, tie-broken by claim ID. **Idempotent ✓.**
- `rule_dempster` — combination via the SL bridge to multinomial mass functions (convert each input to a mass function per §2.5, apply Dempster's rule, convert back to Dirichlet parameters via the inverse bridge). **Non-idempotent ✗**: combining a mass function with itself increases certainty incorrectly when re-ingesting the same evidence; deduplication is required.

So `is_idempotent` is true for `rule_weighted_avg`, `rule_max_mean`, `rule_max_concentration` and false for `rule_evidence_pooled` and `rule_dempster` — the same per-rule contract the §4.9 equational laws and the §5.6 idempotence table depend on, identical in shape to the Beta binding of §5.2.

**Note on the max-selection split.** `rule_max_mean` and `rule_max_concentration` answer different questions and are not interchangeable for Dirichlet: max-mean selects the input whose top category has the highest point estimate (most confident-sounding), while max-concentration selects the input with the most evidence behind it (largest `S`). For example, an input with a sharp top-category mean but small `S` wins under max-mean and loses under max-concentration to a flatter but far-better-evidenced input. Consumers MUST choose explicitly; there is no consumer-friendly default.

References: Jøsang, *Subjective Logic* (Springer, 2016), chapter 6, for the multinomial-opinion treatment and its Dempster-Shafer bridge.

### 5.4 Gaussian / Kalman reference binding `[P]`

Gaussian distributions model continuous measurements — sensor readings, scores, any quantity living on the real line rather than a discrete frame. It is a protocol-tier `[P]` binding: consumers in sensor and measurement domains register it; core implementations (Beta + scalar, §5.2) are not obligated to provide it. `T` is the pair `(μ, σ²)` — mean and variance.

**Statistics.** `mean(d) = μ`; `variance(d) = σ²`; the 95% confidence interval is `μ ± 1.96σ`; `pdf(x)` is the standard Gaussian density. `mean` is the value `rule_max_mean` reads (§4.9); `variance` backs `rule_max_concentration` — lower variance is higher precision is higher concentration of mass around the mean.

**Combination rules.** `combine(rule_id, a, b, params)` dispatches to the per-rule Gaussian math below, using the rule names pinned in §4.9. The two non-trivial rules — `rule_kalman` and `rule_weighted_avg` — are **distinct, not aliases**; the trust-vs-precision distinction between them is load-bearing (see below). `supported_rules()` returns `rule_kalman`, `rule_weighted_avg`, `rule_max_concentration`, and `rule_max_mean`; `rule_dempster` and `rule_evidence_pooled` return NotSupported.

- `rule_kalman` — **precision-weighted Bayesian fusion** of independent measurements of a fixed underlying quantity. Weights = `1/σ²` (precision). The result variance `σ² = 1/(1/σ₁² + 1/σ₂²)` is strictly smaller than either input variance. **Non-idempotent ✗** — fusing a measurement with itself fabricates independence that does not exist and halves the variance; consumers MUST deduplicate by `observation_id` before fusion (§5.1).
- `rule_weighted_avg` — **trust-weighted opinion averaging**. Weights come from the source-trust table in §4.9 (manual=1.3, verification=1.2, workflow=1.0, heuristic=0.9, llm=0.7, imported=0.6), **NOT** from precision. The result is the moment-matched Gaussian of the trust-weighted mixture distribution. **Idempotent ✓** — averaging an opinion with itself preserves the opinion.
- `rule_max_concentration` — lowest-variance argument wins (highest precision = highest concentration of mass around the mean). **Idempotent ✓.** This is the rule for "select the most-precise opinion."
- `rule_max_mean` — argmax over `μ` (highest position wins). **Idempotent ✓.** Rarely the desired semantic for Gaussian inputs — it just picks the rightmost position — but provided for cross-type consistency with the rule contract.
- `rule_dempster` — **NotSupported.** Dempster's rule is defined on discrete frames, and a Gaussian over continuous values has no natural mass-function representation.
- `rule_evidence_pooled` — **NotSupported.** Pooling assumes additive evidence counts (Beta/Dirichlet semantics), which has no direct Gaussian analog.

So `is_idempotent` is true for `rule_weighted_avg`, `rule_max_concentration`, and `rule_max_mean`, and false for `rule_kalman` — the same per-rule contract the §4.9 equational laws and the §5.6 idempotence table depend on. Only the evidence-combining rule (`rule_kalman`) is non-idempotent; the averaging and max-selection rules are idempotent, exactly as for Beta (§5.2) and Dirichlet (§5.3).

**The trust-vs-precision distinction is the load-bearing semantic difference between the two non-trivial rules for Gaussians.** They are NOT aliases. They answer different questions:

- `rule_kalman` answers: "given two independent measurements of the same fixed quantity, what is the Bayesian posterior?" Weights by precision. Reduces variance. Use when sources are equally trusted but you want to reduce uncertainty via independent observations.
- `rule_weighted_avg` answers: "given two opinions about the same proposition with different source trust levels, what is the trust-weighted average opinion?" Weights by source trust. Preserves or increases variance. Use when sources have different trust levels and you want to preserve uncertainty about which is right.

Combining a high-trust imprecise sensor with a low-trust precise one illustrates the difference: `rule_kalman` would weight by precision (low-trust precise wins), `rule_weighted_avg` would weight by trust (high-trust imprecise wins). These produce different means. The choice between them is a domain modeling decision, not a math choice.

**Why the de-aliasing matters for the protocol contract.** The DistributionProtocol (§5.1) exists to provide a uniform rule-name interface across distribution types. If `rule_weighted_avg` collapsed into `rule_kalman` for Gaussians only, a consumer registering a custom distribution type would not know which semantic to implement — trust-weighted averaging (the Beta/Dirichlet contract) or precision-weighted fusion (the Gaussian-aliased version)? Keeping them distinct keeps the contract uniform: `rule_weighted_avg` is always trust-weighted opinion averaging; `rule_kalman` is always precision-weighted Bayesian fusion. Each distribution type implements the semantics correctly for its math, not by aliasing.

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
  w₁, w₂ are normalized source-trust weights from §4.9 (w₁ + w₂ = 1)
  μ_avg  = w₁μ₁ + w₂μ₂
  σ²_avg = w₁σ₁² + w₂σ₂² + w₁w₂(μ₁ − μ₂)²
```

The variance formula is the law of total variance: weighted within-component variance plus between-component variance. The cross-term `w₁w₂(μ₁−μ₂)²` captures the uncertainty about which source is correct, which is exactly what opinion-averaging is supposed to represent. The variance never shrinks below the smaller input; it can be larger than both when the means disagree, which is the right behavior.

**Idempotence verification.** With `G₁ = G₂ = G(μ, σ²)` and any weights `w₁ + w₂ = 1`: `μ_avg = w₁μ + w₂μ = μ`; `σ²_avg = (w₁+w₂)σ² + w₁w₂·0² = σ²`. So `combine_weighted_avg` returns `G(μ, σ²)` exactly. ✓ Idempotent, consistent with the §5.6 idempotence table. (`rule_kalman` makes no such guarantee: with `G₁ = G₂ = G(μ, σ²)` it returns `G(μ, σ²/2)` — the variance halves, which is the non-idempotence flagged above.)

**Caveat: moment-matched approximation can misrepresent bimodal shape.** The moment-matched Gaussian is a *unimodal approximation* of what is potentially a bimodal mixture. When two trusted sources strongly disagree (`(μ₁−μ₂)² > σ₁² + σ₂²`, a rough threshold for visible bimodality), `rule_weighted_avg` returns a single Gaussian centered in the empty space between the modes with inflated variance — "probably around the midpoint, uncertain" when the truth is "A or B, not between." This is at odds with §1's rationale for preserving disagreement structure via clusters.

When the between-means term `w₁w₂(μ₁−μ₂)²` dominates the within-variance terms `w₁σ₁² + w₂σ₂²`, the moment-matched Gaussian misrepresents the shape of the underlying mixture. Consumers should consider cluster-style representation (per §1, §4.8) instead of averaging, or fuse via `rule_kalman` if the sources are genuinely independent measurements of the same quantity. The library can detect this condition at runtime and warn: the v0.2 reference implementation emits a `bimodal_approximation_warning` when the between-means term exceeds the within-variance terms by 2× or more — i.e. when `w₁w₂(μ₁−μ₂)² ≥ 2·(w₁σ₁² + w₂σ₂²)`.

**Connection to the §5.6 idempotence table.** The de-aliasing keeps the rule-level idempotence claims valid across all distribution types. `rule_weighted_avg` is idempotent for Beta, Dirichlet, scalar, AND Gaussian inputs. The earlier "Gaussian weighted_avg is non-idempotent because it is a kalman alias" claim was a regression that contradicted the §5.6 idempotence table; this de-aliasing removes the contradiction. The reference implementation flags the non-idempotence of `rule_kalman` loudly: **consumers using `rule_kalman` MUST implement observation-level deduplication** — re-ingesting the same measurement with the same `observation_id` must be filtered before fusion (§5.1). The protocol's `is_idempotent(rule_id)` returns false for `rule_kalman` so callers know to deduplicate.

References: Welch & Bishop, "An Introduction to the Kalman Filter" (UNC, 1995, periodically updated). For the moment-matching of mixtures, any standard text on mixture distributions or Bayesian model averaging.

### 5.5 Mixed-distribution combination `[P]`

When a combination operation receives inputs of different distribution types, the library checks whether either type has a registered conversion to the other (via the DistributionProtocol's `to_subjective_logic_opinion` bridge or an explicit consumer-registered converter), applies the conversion if available, performs the combination in the unified type, and returns the result in that unified type. Combination across types with no registered conversion returns NotSupported.

**Standard conversions.** The reference implementations register the following:

- **scalar → Beta**: a scalar carries no evidence weight on its own, so coercion to Beta requires an explicit, declared pseudocount. The conversion is

  ```
  scalar_to_beta(s, pseudocount, a):
    α = s · pseudocount + a · W
    β = (1 − s) · pseudocount + (1 − a) · W
  ```

  where `s` is the scalar, `pseudocount` is the strength-of-evidence the scalar represents (expressed as an effective observation count), and `W`, `a` are the corpus's prior weight and base rate from §1.2. The `s · pseudocount` term is the raw-evidence contribution (treating the scalar as the expectation over `pseudocount` observations); the `a · W` term adds the prior. The result has `α + β = pseudocount + W` — the correct prior-inclusive structure. The `pseudocount` parameter is **required, not defaulted**: it is declared either by the corpus schema (`scalarPseudocount: Map<Source, Number>`) or as an explicit argument to the conversion operator. Implementations MUST NOT default the pseudocount silently. **A combination operation that requires scalar-to-Beta coercion without a declared pseudocount MUST fail at parse time.** (A scalar of 0.8 maps to `Beta(8, 2)` and to `Beta(80, 20)` with the same mean but ten times the evidence weight; the choice silently determines how much a scalar-source claim dominates in subsequent pooling, so it cannot be left implicit.) As consumer guidance only — calibrate to the domain — high-trust sources (manual, verification) warrant pseudocount ≥ 10, medium-trust (workflow, heuristic) ≈ 5, low-trust (llm, imported) ≈ 2.
- **Beta → Dirichlet (same frame)**: a `Beta(α, β)` over {True, False} maps directly to a 2-category `Dirichlet(α, β)`. Same frame, no semantic shift — trivial.
- **Beta → SL opinion**: via the corrected Beta-to-opinion bridge of §5.2.
- **Dirichlet → SL opinion**: via the generalized Dirichlet-to-opinion bridge of §5.3.

No standard conversion exists for Gaussian ↔ Beta or Gaussian ↔ Dirichlet; combination across these types returns NotSupported, and consumers needing it register custom converters via the DistributionProtocol.

**Frame extension is NOT a standard conversion.** A Beta-typed claim about "is at Port A" has frame {True, False}; a Dirichlet-typed claim about "vessel location" has frame {Port A, Port B, Port C}. These are *different propositions*: a Beta about a singleton is not equivalent to a Dirichlet over the full frame, and the library cannot silently convert between them. When combining claims that nominally describe the same fact but use different frames, the consumer must perform explicit frame extension before combination. The library provides:

```
extend_to_frame(beta: Beta, target_frame: Frame, mapping: BetaToFrameMapping) → Dirichlet

BetaToFrameMapping {
  trueMapsTo  : SingletonId          -- which singleton in the target frame corresponds to "True"
  -- "False" mass is split among remaining singletons proportionally
  -- to the target frame's declared base rates
}
```

**Semantic: strip the Beta's prior, then redistribute the raw evidence under the target frame's prior structure.** This ensures the resulting Dirichlet has internally consistent priors regardless of whether the Beta's base rate matched the target's. For input `Beta(α, β)` with binary prior `(W_b, a_b)` and target frame {A, B, C} with base rates `(a_A, a_B, a_C)` and prior weight `W_t`, with `trueMapsTo = A`:

```
-- Step 1: Strip the Beta's prior to recover raw evidence counts
r = α − a_b · W_b               -- raw positive evidence
s = β − (1 − a_b) · W_b         -- raw negative evidence

-- Step 2: Distribute raw counts under the target frame's prior structure
α_A = r + a_A · W_t                       -- True evidence goes to A, with A's prior
α_B = s·(a_B/(1−a_A)) + a_B · W_t         -- False evidence ∝ base rate, with B's prior
α_C = s·(a_C/(1−a_A)) + a_C · W_t         -- False evidence ∝ base rate, with C's prior
```

The output is `Dirichlet(α_A, α_B, α_C)`, with uniform prior weight `W_t` across all categories and prior structure matching the target frame's declared base rates.

**Worked example.** `Beta(3, 2)` with `W_b = 2`, `a_b = 0.5` (so `r = 2`, `s = 1`). Target frame {A, B, C} with `a_A = 0.5`, `a_B = 0.3`, `a_C = 0.2`, `W_t = 2`. `trueMapsTo = A`.

- α_A = 2 + 0.5·2 = 3
- α_B = 1 · (0.3 / 0.5) + 0.3·2 = 0.6 + 0.6 = 1.2
- α_C = 1 · (0.2 / 0.5) + 0.2·2 = 0.4 + 0.4 = 0.8

Result: `Dirichlet(3, 1.2, 0.8)`. Total concentration = 5. In this example the input Beta has `α + β = 5` and `W_b = 2 = W_t`, so the concentrations match — but this equality is a property of the example's matched W's, not a general guarantee (see Properties below). Sum of priors = `a_A·W_t + a_B·W_t + a_C·W_t = 2` (matches `W_t`). ✓ Prior structure is internally consistent.

**Properties of this construction:**

- *Raw-evidence preserving*: `r + s` is preserved exactly across the operation. The evidence count from the input survives intact in the output's category totals (after subtracting the target priors).
- *Total concentration*: `Σαᵢ = r + s + W_t`. This equals the input's `α + β` **only when `W_t = W_b`**. The worked example happens to satisfy this (both W's are 2), which makes the totals match; in the general case the totals differ by `(W_t − W_b)`.
- *Prior-consistent*: the resulting Dirichlet's prior structure has uniform weight `W_t` across all categories, matching the target frame's declared base rates.
- *Convention-clean*: in the raw-count view `(r, s) → (r_A, r_B, r_C)`, the operation is just "True-evidence goes to A; False-evidence splits between B and C proportionally to base rates."
- *Round-trip*: marginalizing the result back to a 2-category {A, ¬A} Dirichlet recovers `Beta(α_A, α_B + α_C) = Beta(r + a_A·W_t, s + (1−a_A)·W_t)`. This equals the input Beta when `(a_b, W_b) = (a_A, W_t)`; otherwise it recovers the input's raw evidence `(r, s)` paired with the target frame's prior structure — which is the operation's intended renormalization, not a defect.

**Caveat: this is a maximum-entropy approximation, not a lossless conversion.** The original Beta knew "False" was about a singleton outside {A}; the extended Dirichlet now treats the False evidence as informative about B vs. C in proportion to base rates. This introduces information that was not in the original Beta. The base-rate split is the maximum-entropy choice given no further information, but it remains an approximation.

Consumers who need to preserve "the original source had no opinion about B vs. C" must register a custom converter using a Jøsang hyper-opinion representation — placing mass on the composite focal element {B, C} rather than splitting it between the singletons. Hyper-opinions require extending the DistributionProtocol to support powerset-indexed mass functions, which is outside v0.2 scope. The base-rate split is the v0.2 default; finer control is via custom converter (the hyper-opinion escape hatch).

### 5.6 Combination-rule catalog `[P]`

§5.2–§5.5 specify, per binding, *which* rules each distribution supports and *whether* each is idempotent. This subsection is the normative catalog of *what each rule computes* and the cross-distribution contract that ties the rule names together. The `combine(rule_id, …)` dispatch of §5.1 resolves each `rule_id` to the per-distribution math below; the algebra of §4.9 never names anything not catalogued here.

**Protocol-uniform-rule-name contract.** A `rule_id` denotes one semantic, and every binding that supports it MUST implement *that* semantic for its own math — never a different operation under the same name. `rule_weighted_avg` is always trust-weighted opinion averaging (weights from the source-trust table of §4.9), for Beta, Dirichlet, scalar, and Gaussian alike; it is never silently aliased to precision-weighted fusion. `rule_evidence_pooled` is always additive evidence accumulation with single-prior accounting. `rule_max_mean` always selects the highest point estimate; `rule_max_concentration` always selects the most evidence. `rule_dempster` is always Dempster's rule on the subjective-logic mass functions of §2.5. `rule_kalman` is always precision-weighted Bayesian fusion. A binding that cannot give a rule its contracted semantic MUST return NotSupported rather than substitute a near-neighbour (this is why the Gaussian binding refuses `rule_evidence_pooled` and `rule_dempster`, §5.4, instead of approximating them). This is what lets the §4.9 algebra and a consumer's custom binding agree on what a `rule_id` means without inspecting the distribution type: the name carries the semantic, the binding carries the math.

The catalogued rules:

#### `rule_weighted_avg` — trust-weighted averaging

Trust-weighted average of the inputs, weights drawn from the source-trust table of §4.9 (manual=1.3, verification=1.2, workflow=1.0, heuristic=0.9, llm=0.7, imported=0.6), normalized over the input set. For Beta/Dirichlet it averages the parameter vectors; for Gaussian it returns the moment-matched Gaussian of the trust-weighted mixture (§5.4); for scalar it averages the point values. **Idempotent ✓** for every binding: averaging a value with itself returns the value. This is a *selecting/normalizing* rule, not an evidence-accumulating one — it never inflates the evidence total, so re-ingesting the same input does not fabricate certainty.

#### `rule_evidence_pooled` — additive evidence pooling (Beta)

Pooling treats each input's parameters as *prior-inclusive* evidence counts under the pinned convention `α = r + a·W`, `β = s + (1−a)·W` (§0.3). Pooling two inputs means summing their *raw* evidence and re-applying exactly one prior — not summing the parameters directly, which would carry the prior weight `W` once per input. For `Beta(α₁, β₁)` and `Beta(α₂, β₂)` with prior weight `W` and base rate `a`:

```
α_pooled = α₁ + α₂ − a·W
β_pooled = β₁ + β₂ − (1−a)·W
```

The `−a·W` and `−(1−a)·W` terms remove the one duplicated prior: each input contributed `a·W` to its `α`, so the sum `α₁ + α₂` contains `2·a·W` of prior mass when the pooled result should contain only `a·W`. This is mathematically identical to "extract raw `r = α − a·W` and `s = β − (1−a)·W` from each input, sum the raw counts, then re-add a single prior `(a·W, (1−a)·W)`"; both formulations produce the same result.

**N-input generalization.** Pooling `N` Beta inputs in one call carries `N` priors and must keep one, so it removes `N−1`:

```
α = (Σ αᵢ) − (N−1)·a·W
β = (Σ βᵢ) − (N−1)·(1−a)·W
```

Pairwise pooling in any order gives the same result by associativity, so implementations SHOULD use this closed form for `N` inputs rather than reducing pairwise — it avoids floating-point accumulation error and makes the prior subtraction explicit.

**Worked example.** Two claims, each `Beta(3, 2)` with `W = 2`, `a = 0.5`. Under the pinned convention each is `r = 2` positive, `s = 1` negative (since `α = 2 + 0.5·2 = 3`, `β = 1 + 0.5·2 = 2`). Pooling:

```
α_pooled = α₁ + α₂ − a·W   = 3 + 3 − 1 = 5
β_pooled = β₁ + β₂ − (1−a)·W = 2 + 2 − 1 = 3
```

Result: `Beta(5,3)` — mean 0.625, concentration 8. This is the correct pooling: raw counts sum to `r = 4`, `s = 2`, and re-adding one prior gives `α = 4 + 1 = 5`, `β = 2 + 1 = 3`. A naive parameter sum would give `Beta(6, 4)` (mean 0.600, concentration 10), carrying one extra `W` of phantom evidence — exactly the prior, double-counted. The catalogued form does not do this.

For three `Beta(3,2)` inputs the closed form gives `α = 3·3 − 2·1 = 7`, `β = 3·2 − 2·1 = 4` — `Beta(7,4)` — matching pairwise pooling (`Beta(5,3)` then pool with the third to `Beta(7,4)`), confirming associativity.

`rule_evidence_pooled` is the same additive-pooling semantic on the Dirichlet binding (§5.3): sum the parameter vectors with the analogous per-category prior-`W` subtraction. **Non-idempotent ✗** on every binding that supports it — pooling a value with itself accumulates evidence and inflates the concentration, so consumers MUST deduplicate by `observation_id` before pooling (§5.1). The Gaussian binding returns NotSupported (pooling assumes additive evidence counts with no Gaussian analog, §5.4); evidence accumulation for Gaussian measurements is `rule_kalman`'s job, under its own name and its own non-idempotence.

#### `rule_max_mean` and `rule_max_concentration` — the `rule_max` split

v0.1's single `rule_max_confidence` rule (now deprecated, see below) was ambiguous: its name ("highest-confidence wins") reads as max-*mean* (highest point estimate), but the protocol-tier Dirichlet implementation had quietly committed to max-*concentration* (the most-evidenced input). The two diverge — `Beta(9, 1)` has mean 0.9, concentration 10; `Beta(80, 20)` has mean 0.8, concentration 100; max-mean picks the first, max-concentration the second — so a single name covering both broke the protocol-uniform-rule-name contract. The fix splits it into two rules with distinct, unambiguous semantics:

```
rule_max_mean          : argmax over the mean (point estimate) of each input
rule_max_concentration : argmax over the total evidence weight (concentration) of each input
```

- `rule_max_mean` selects the input with the highest point estimate — "which input sounds most confident?", regardless of evidence backing. Per distribution: Beta `α/(α+β)`; Dirichlet picks the input whose most-likely category has the highest mean; Gaussian `μ` (rarely the desired Gaussian semantic — it just picks the rightmost position — but provided for cross-type consistency); scalar the value itself.
- `rule_max_concentration` selects the input with the most evidence behind it — "which input is best-evidenced?". Per distribution: Beta/Dirichlet total concentration `α+β` / `Σαᵢ`; Gaussian precision `1/σ²` (lowest variance wins, the "most-precise opinion" selection); scalar concentration is the consumer-declared pseudocount.

Both are **idempotent ✓** (argmax of a value against itself returns that value) given a stable, total tie-breaker; the library defaults to lexicographic ordering on claim ID, overridable per-corpus, and the same tie-breaker secures associativity. For Dirichlet under `rule_max_mean`, two inputs whose top categories share the same mean are tied even when those top categories *differ* (e.g. `Dirichlet(8,1,1)` and `Dirichlet(1,8,1)` both have top-category mean 0.8), and the tie-breaker decides.

`rule_max_mean` and `rule_max_concentration` answer genuinely different questions and there is no consumer-friendly default; consumers MUST choose explicitly. This is the same de-aliasing principle as the Gaussian `rule_kalman` / `rule_weighted_avg` split (§5.4): when two operations have different semantics, they get different names.

> **`rule_max_confidence` — DEPRECATED.** The v0.1 name `rule_max_confidence` is deprecated as ambiguous and is **removed**, not pinned. This is a breaking change for v0.1 consumers. The library MUST reject any query or write referencing `rule_max_confidence` with a **typed error**, and that error MUST name **both** replacements — `rule_max_mean` (point-estimate selection) and `rule_max_concentration` (evidence-weight selection) — and state the semantic distinction so the consumer can choose. Silent migration to either replacement is **forbidden**: defaulting would mask cases where the consumer wanted the other semantic. Implementations migrating from v0.1 MUST audit existing `rule_max_confidence` usage and replace each occurrence explicitly. Splitting and forcing an explicit choice — rather than pinning one interpretation and surprising the consumers who relied on the other — is the principled fix; the breaking change is the cost of restoring the protocol contract.

#### `rule_dempster` — Dempster combination

Dempster's rule of combination on the subjective-logic mass functions of §2.5: convert each input to a mass function via its `to_subjective_logic_opinion` bridge, apply Dempster's rule, convert the result back. Supported by the Beta and Dirichlet bindings (which expose the bridge); NotSupported by Gaussian (no natural mass-function representation over a continuous frame, §5.4). Dempster's rule is unconditionally **commutative and associative** — `m₁ ⊕ m₂ = m₂ ⊕ m₁` and `(m₁ ⊕ m₂) ⊕ m₃ = m₁ ⊕ (m₂ ⊕ m₃)`, with the vacuous mass function as identity. The counterintuitive high-conflict behaviour (Zadeh's example: two sources strongly favouring different singletons combine to strongly support a third) is a *property of the rule*, not a failure of associativity, so the optimizer MAY freely reorder Dempster combinations. **Non-idempotent ✗**: `m ⊕ m ≠ m` in general — combining a mass function with itself increases certainty, which is wrong when re-ingesting the same evidence, so deduplication is required.

#### `rule_kalman` — precision-weighted fusion (Gaussian)

Precision-weighted Bayesian fusion of independent measurements of a fixed quantity, supported only by the Gaussian binding (§5.4). Weights are precisions `1/σ²`; the fused variance `σ² = 1/(1/σ₁² + 1/σ₂²)` is strictly smaller than either input. **Non-idempotent ✗** — fusing a measurement with itself fabricates independence and halves the variance, so consumers MUST deduplicate by `observation_id` before fusion. `rule_kalman` is the Gaussian evidence-accumulating rule; it is *not* an alias of `rule_weighted_avg` (trust-weighted, idempotent) — the trust-vs-precision distinction is load-bearing (§5.4).

#### Idempotence summary

The per-rule idempotence flags, consolidated across bindings (the contract the §4.9 equational laws and this idempotence table both depend on; matches the per-binding flags of §5.2–§5.4):

| Rule | Idempotent |
|---|---|
| `rule_weighted_avg` | ✓ |
| `rule_evidence_pooled` | ✗ |
| `rule_max_mean` | ✓ |
| `rule_max_concentration` | ✓ |
| `rule_dempster` | ✗ |
| `rule_kalman` | ✗ |

The pattern is semantic, not incidental: the *averaging* rule (`rule_weighted_avg`) normalizes and the *selecting* rules (`rule_max_mean`, `rule_max_concentration`) perform no combination, so all three are idempotent; the *evidence-accumulating* rules (`rule_evidence_pooled`, `rule_dempster`, `rule_kalman`) add information on every application and so inflate certainty when fed duplicate inputs — `is_idempotent(rule_id)` (§5.1) returns false for them precisely so callers know observation-level deduplication is mandatory before combining.

---

## 6. Catalog operations

The catalog model (§3) defines corpora as named, schema-bound, access-controlled entities; this section specifies the *operations* over that catalog. Catalog operations divide into three groups: managing corpora (§6.1), discovering them (§6.2), and querying across several of them at once (§6.3). All catalog operations are subject to the access policy (§3.4) of the corpora they touch, enforced through the authorization adapter (§9).

### 6.1 Corpus management

```
createCorpus(definition: CorpusDefinition) → Corpus
updateCorpusSchema(id: CorpusId, schema: ClaimSchema, migration: Migration?) → Corpus
updateCorpusPolicy(id: CorpusId, policy: AccessPolicy) → Corpus
deleteCorpus(id: CorpusId, options: DeleteOptions) → DeletedCorpusReceipt
```

Corpus creation requires a schema (§3.2) and an access policy (§3.4). Schema updates trigger validation against existing claims and MAY require a migration path: changing the schema of a populated corpus is a write-model concern, so the migration is applied under the write pipeline's conformance and visibility rules (see §7). A schema update whose new constraints are not satisfiable by the existing claims, and for which no migration is supplied, MUST be rejected rather than leaving non-conforming claims in place.

Policy updates take effect at the next enforcement point (§9); they do not retroactively rewrite already-delivered results. Deletion is irreversible and produces a `DeletedCorpusReceipt` for audit purposes. Every management operation requires `admin` rights on the target corpus per its access policy, and — like access denials — is itself an auditable event written to the designated audit corpus.

### 6.2 Discovery

```
listCorpora(filter: CorpusFilter?) → List<Corpus>
getCorpus(id: CorpusId) → Corpus
getCorpusSchema(id: CorpusId) → ClaimSchema
```

Discovery operations are read-only and respect the access policy (§3.4): corpora the caller cannot read are not returned by `listCorpora`, and `getCorpus`/`getCorpusSchema` for a corpus the caller cannot read are denied as a read-access failure (not reported as "not found", except where a profile deliberately conflates the two to avoid leaking existence). Enforcement is through the authorization adapter at the read enforcement point (§9).

### 6.3 Multi-corpus queries

Queries that span multiple corpora reference them by name in the query expression:

```
let general = σ_status=validated (corpus("wiki:nestjs-general"))
let project = σ_status=validated (corpus("wiki:crewtracks-modules"))
let layered = project ⊳ general
```

The library MUST enforce access policy on each corpus reference **individually** — the caller must have read access to *every* corpus referenced in a query. Access is checked per reference, not once for the query as a whole: a query that names one readable and one unreadable corpus is denied, never silently narrowed to the readable subset.

Multi-corpus queries that combine corpora via ⊳, ⋈, or set operations produce a result corpus whose schema is the **union** of the input schemas — or the **intersection**, for restrictive operations that can only emit fields common to all inputs. The library validates that combining operations are schema-compatible before evaluation; incompatible combinations fail at parse time rather than producing claims that violate the result schema.

---

## 7. Write model

The write model defines how claims enter the corpus. It specifies the pipeline a write traverses, the visibility guarantees a successful commit provides, the contradiction policies enforced at write time, the transaction and batch primitives, the derived-write provenance discipline, and idempotency.

### 7.1 Write pipeline

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
5. Apply cheap contradiction checks (exact key+scope match; see §7.3)
6. Assign `id`, `recorded`, `status`

**Commit** — the promoted claim is written to storage. The corpus's logical timestamp advances. Subscribers are notified asynchronously.

Two modes are supported:
- **Immediate-promote** — emission, promotion, and commit happen in one call. The writer takes responsibility for full claim shape; the library does minimal processing.
- **Staged-promote** — candidates are explicitly emitted; promotion can be batched, deferred, or pipelined.

Most writers use immediate-promote. Staged-promote is for high-throughput ingestion (telemetry, observability) where batching saves cost.

**Reference implementation note.** The reference implementation uses **immediate-promote as the default mode**: emission, promotion, and commit occur in a single call. **Staged-promote** is available via an in-memory staging buffer: callers emit candidates that are held in the buffer, then promote them as a deferred, batched flush. This keeps the common case simple while enabling the high-throughput path without requiring a separate API surface.

**Correctness vs. performance.** The pipeline described above is a *correctness* model, not a prescription of physical execution. Implementations MAY batch, parallelize, or pipeline the stages provided that the observable behavior — atomic visibility, durability, and contradiction-checking semantics — is preserved. High-throughput consumer workloads (>1000 writes/sec) typically require batched promotion with parallel commit threads. The reference SQLite adapter is single-writer and is not appropriate for such workloads; the reference Postgres adapter supports parallel writers via MVCC.

### 7.2 Visibility guarantees

When a commit call returns successfully, the library guarantees:

- **Durability** — the claim is persisted to storage (fsync or equivalent). Survives library restart.
- **Read-your-writes within session** — the next snapshot query from the same session will see the new claim.
- **Recorded-time advance** — the corpus's logical timestamp has advanced past the new claim's `recorded` instant.

The library does NOT guarantee:

- **Synchronous subscription delivery** — subscribers are notified asynchronously, with at-least-once delivery semantics (see §8).
- **Cross-session immediate visibility** — concurrent readers from other sessions may briefly see the pre-write state (eventual consistency on the order of milliseconds).

A stronger guarantee — synchronous subscriber acknowledgment before commit returns — is available via opt-in flag (`commit(claim, wait_for_subscribers = true)`) but should be used sparingly because it ties writer latency to subscriber speed.

### 7.3 Contradiction policies

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

**Cheap vs. expensive contradiction checking.** At write time, the library performs *cheap* contradiction checks — exact match on `(subject, key, scope)` with different values. Because `(profile, key, scopeHash)` is a *non-unique index* (the unique primary key on a claim is its `id`), multiple claims may share that triple — typically one currently-validated claim plus deprecated supersession history. The cheap contradiction check MUST therefore additionally filter by status to find the currently-validated competing claim, not merely any historical claim; the algebra's standard `σ_status=validated` expresses this filter. Expensive checks (semantic-similarity contradictions, multi-claim aggregate contradictions) are deferred to read-time via the ⊥ operator (§4.8).

### 7.4 Transactions

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

**Interaction with subscriptions**: subscribers see a transaction as a single corpus-state advance, not as N separate events. A subscription with `trigger: on_every_match` will fire once per matching claim within the transaction, but the underlying corpus state advances only once (see §8).

**Interaction with contradiction policies**: within a transaction, contradictions are checked against the *post-transaction* state. Two writes within a transaction can contradict each other; resolution depends on the transaction's policy.

**Interaction with derived writes**: derived claims can reference earlier writes within the same transaction. The derivation provenance records the pre-transaction corpus state (the state the query saw); the derived claim is committed as part of the same transaction.

Transactions have bounded size. The library MAY reject transactions that exceed implementation-defined limits (e.g., 1000 writes per transaction). For larger batches, use the batch primitive (§7.5).

### 7.5 Batch writes

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

### 7.6 Derived writes

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

The derivation provenance (the `DerivationProvenance` type of §2.7) records:
- The query expression that produced the claim (serialized)
- The corpus state at evaluation time
- The combination rule used (if synthesis)
- The set of input claim IDs that contributed
- `similarityVersions` — the version of every similarity function used in the query
- `embeddingModelVersions` — the version of every embedding model used (e.g., the model version captured when `ρ_cosine` is invoked)
- `evaluationClock` — the pinned evaluation time for time-dependent operators (decay, `τ_now`), eliminating decay drift during replay

**Mandatory version provenance.** `commit_derived` MUST populate `similarityVersions` and `embeddingModelVersions` when the query expression references similarity-based operators. A derived write that omits these fields when the query requires them is invalid and MUST be rejected. The decision to record version information is *irreversible at write time*: a derivation committed without versions cannot retroactively gain them — the information is gone. Implementations MUST begin recording version information immediately, even if the broader replay-verification machinery is not yet built; recording without using is cheap, while not recording forecloses future use.

**Version-conditional reproducibility.** A derived claim is reproducible *conditional on version availability* — the spec does NOT claim universal reproducibility. A consumer can re-run the serialized query against the recorded corpus state and verify the result *iff*:
1. All input claims are present in the corpus;
2. All similarity-function versions referenced in provenance remain available in the catalog;
3. All embedding-model versions referenced in provenance remain available;
4. The `evaluationClock` is used for time-dependent operators.

This replaces the v0.1 blanket reproducibility claim ("any consumer can re-run the serialized query against the recorded corpus state and verify they get the same derived claim") with the version-aware claim above. Marketing materials and product documentation should reflect this corrected, version-conditional language rather than asserting universal reproducibility.

**Replay status.** When any of the conditions above fails, replay produces a defined degraded result rather than a silent mismatch:

```
ReplayResult {
  status              : ReplayStatus
  result              : Claim?
  missingDependencies : List<MissingDependency>
}

ReplayStatus =
  | exact                    -- all conditions met, result matches recorded
  | unavailable_models       -- provenance recorded model versions, but those versions are no longer available
  | missing_inputs           -- provenance recorded input claim IDs, but those claims are no longer present
  | integrity_unknown        -- derivation committed before mandatory provenance fields existed (v0.1-era); cannot verify
  | failed                   -- replay fundamentally cannot proceed
```

For v0.1-era derived claims that lack the version fields, the library treats their replay status as `integrity_unknown`. This distinguishes "we committed without recording what we needed" (`integrity_unknown`) from "we recorded versions but those versions are gone now" (`unavailable_models`). There is no path to retroactively add the missing version information to a v0.1-era derivation; consumers needing reproducibility for these claims must re-derive them under the current provenance discipline.

The library MUST preserve the corpus state at the time of derivation long enough for verification — typically until either an explicit retention policy expires or the derived claim is itself deprecated.

### 7.7 Idempotency

Every write supports an optional idempotency key:

```
commit(claim, idempotencyKey: string?) → CommitResult
```

If a write with the same idempotency key has been processed within the idempotency window (default: 24 hours), the library returns the original result without re-processing. This protects against retries during transient failures.

Idempotency keys are scoped to (corpus, writer-identity, key) — the same key from different writers does not collide.

---

## 8. Subscription model

A subscription registers a long-running query against a corpus together with a notification target. When the corpus evolves in ways that match the subscription's trigger semantics, the library delivers notifications to the target. Subscriptions are how consumers turn the query algebra of §4 from a pull interface into a push interface: the same expression that retrieves a result on demand can instead drive a stream of incremental notifications as the corpus changes.

### 8.1 Subscription primitive

```
subscribe(
  query     : AlgebraExpression,
  trigger   : TriggerSemantics,
  target    : DeliveryTarget,
  lifecycle : LifecyclePolicy
) → SubscriptionHandle
```

The `query` is any algebra expression of §4. The `trigger` (§8.2) decides *when* a notification fires; the `target` (§8.4) decides *where* it is delivered; the `lifecycle` (§8.7) decides *how long* the subscription lives. The returned `SubscriptionHandle` is used to cancel the subscription and to inspect its durable state (§8.8).

### 8.2 Trigger semantics

```
TriggerSemantics =
  | on_every_match                                 -- fire on each new claim matching the query
  | on_transition(direction: Direction)            -- fire when result set crosses a boundary
  | on_every_write                                 -- fire on every corpus mutation regardless of match

Direction = to_nonempty | to_empty | either
```

**`on_every_match`** — for each newly-matching claim, fire one notification. Used for streaming insights, audit-log forwarding, and derived-write triggers.

**`on_transition(direction)`** — fire when the query's result transitions across an empty/nonempty boundary. Used for "alert when something starts happening" (`to_nonempty`) or "alert when something stops happening" (`to_empty`). Requires the library to maintain transition state (§8.8).

**`on_every_write`** — fire on every commit, regardless of whether it matches the query. Used for comprehensive audit pipelines.

Triggers interact with the transaction semantics of §7.4: subscribers see a transaction as a single corpus-state advance, not as N separate events. A subscription with `trigger: on_every_match` fires once per matching claim within the transaction, but the underlying corpus state advances only once.

### 8.3 Streamable vs. non-streamable operators

Subscriptions over arbitrary query expressions may be expensive. The library classifies operators by incremental-evaluation cost, consistent with the per-operator incremental-evaluation notes in §4.

**Streamable** (incremental cost O(1) or O(log n) per write):

- σ, π, τ, δ, ⊥, ⊳, ⊕_dedupe
- ⋈ on indexed fields
- γ for bounded depth

The contradiction operators are streamable in both forms (§4.8): a new claim introduces contradictions only with existing claims sharing its `(subject, key, scope)`, so the search is scoped to that triple. This applies to the n-way clustered form `⊥_clusters` as well as `⊥_pairs` — a new claim joins an existing cluster, starts a new cluster, or resolves one — so `⊥_clusters` is **streamable**. The library maintains per-triple cluster state in subscription state (§8.8), updated incrementally on each write.

**Conditionally streamable** — the aggregation family α (§4.13) is streamable only for certain aggregates:

- `α_count`, `α_sum`, `α_avg`, `α_rate` are streamable — each write contributes to running totals.
- `α_min`, `α_max` are streamable for additions but require a re-scan for deletions (add-only).
- `α_groupBy` is streamable when the group-field is stable per claim.
- `α_custom` depends on the function — consumers declare streamability via the `AggregateFunction` protocol.

A subscription whose query includes aggregation must be over streamable aggregates, or it pays the re-evaluation cost on each corpus change (and is treated like a non-streamable subscription below).

**Non-streamable** (require re-evaluation or have pathological worst-case):

- ρ (similarity ranking) — new claims may shift the top-K.
- ⊕_synthesize_as — new claims may shift the synthesis (and for some combination rules the result is order-dependent).
- κ, φ_format, β_budget — composition is order- and budget-sensitive.

Subscriptions over query expressions containing non-streamable operators are allowed but emit warnings, and the library MAY apply rate limiting or downsampling. The spec recommends consumers structure subscriptions to avoid non-streamable operators where possible (e.g., subscribe to the underlying selection and apply ranking or composition in the consumer).

### 8.4 Delivery targets

```
DeliveryTarget =
  | webhook(url: URL, headers?: Map<string, string>)
  | mcp_channel(serverId: string, channelId: string)
  | in_process_callback(fn: Function)
  | persistent_queue(queueId: string)
  | log_sink(corpusId: CorpusId)
```

Delivery targets are pluggable. Standard targets cover webhooks, MCP channels (for AI-agent consumers), in-process callbacks (for tight coupling), persistent queues (for guaranteed-delivery integration), and log sinks (for writing notifications back into a designated corpus).

### 8.5 Delivery semantics

The library provides **at-least-once delivery** with **idempotency keys** and **causal ordering**:

- Every notification carries a unique idempotency key (`subscriptionId + corpusTimestamp + matchingClaimId`).
- Consumers are expected to be idempotent against retries.
- Notifications from a single subscription are delivered in causal order (corpus-timestamp-ordered).
- Notifications from different subscriptions have no cross-subscription ordering guarantee.

Stronger semantics (exactly-once, cross-subscription ordering) require coordination with the consumer and are not provided by default. Notification delivery is asynchronous by default (§7.2); a stronger synchronous-acknowledgment guarantee is available via the opt-in `commit(claim, wait_for_subscribers = true)` flag, which ties writer latency to subscriber speed and should be used sparingly.

### 8.6 Backpressure

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

### 8.7 Lifecycle

```
LifecyclePolicy =
  | until_cancelled                                -- runs until explicitly cancelled
  | until_event(predicate: EventPredicate)         -- runs until matching event
  | ttl(duration: Duration)                        -- expires after duration
  | composite(policies: List<LifecyclePolicy>)     -- any condition terminates
```

Subscriptions can be cancelled explicitly via the `SubscriptionHandle`, or expire automatically per the lifecycle policy. Cancellation is irreversible.

### 8.8 Subscription state

Subscriptions with `on_transition` triggers — and streamable subscriptions that maintain incremental result state, including `⊥_clusters` per-triple cluster state (§8.3) and running aggregate totals (§4.13) — maintain state to evaluate transitions and incremental updates. The library stores per-subscription state separately from the corpus:

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

## 9. Access control integration

The library does not implement authorization internally. It delegates every access decision to a pluggable authorization adapter. This keeps the core engine-agnostic: the access-policy fields of a corpus (§3.4) name `PrincipalPattern`s, but the library never interprets them directly — it passes the principal, the corpus, and the operand to the adapter and acts on the returned decision.

### 9.1 Authorization adapter protocol

The authorization adapter conforms to the following `[P]` protocol contract:

```
AuthorizationAdapter {
  canRead(principal: Principal, corpus: CorpusId, claim?: Claim) → Decision
  canWrite(principal: Principal, corpus: CorpusId, candidate: CandidateClaim) → Decision
  canSubscribe(principal: Principal, corpus: CorpusId, query: AlgebraExpression) → Decision
  canAdmin(principal: Principal, corpus: CorpusId) → Decision
}

Decision = allowed | denied(reason: string)
```

Each method returns a `Decision` that is either `allowed` or `denied(reason)`, where `reason` is a human-readable string explaining the denial. Bedrock is a reference implementation of this protocol. The library is engine-agnostic — any system implementing the protocol works.

### 9.2 Enforcement points

The library MUST call the authorization adapter at every:

- **Read** (snapshot query) — `canRead` per corpus referenced.
- **Write** — `canWrite` per claim being committed (see the write model, §7).
- **Subscribe** — `canSubscribe` per corpus referenced (see the subscription model, §8).
- **Catalog operation** — `canAdmin` for schema/policy modifications (see catalog operations, §6).

Authorization decisions are themselves written to a designated audit corpus, providing a queryable record of access patterns. Because the audit record is an ordinary corpus, access patterns can be inspected with the standard query algebra (§4).

### 9.3 Row-level access

Per-claim authorization is supported via `canRead(principal, corpus, claim)`. When this returns `denied` for individual claims, those claims are filtered from query results — the query succeeds but returns the visible subset. This implements row-level access control without requiring queries to know about authorization.

---

## 10. Storage adapter protocol

The library is implemented over pluggable storage adapters. Each adapter conforms to the following `[P]` protocol contract:

```
StorageAdapter {
  -- Claim operations
  insertClaim(claim: Claim) → Result
  getClaim(id: ClaimId) → Claim?
  deleteClaim(id: ClaimId) → Result                -- soft delete (deprecation)

  -- Bulk operations
  insertBatch(claims: List<Claim>) → BatchResult
  query(plan: ExecutionPlan) → ClaimIterator

  -- Transactions (closure form)
  transaction<T>(fn: () → T) → T
  -- closure form: unbalanced/leaked transactions are structurally impossible — the library owns the boundaries

  -- Subscriptions (optional; adapter may not support push)
  subscribeChanges(filter: ChangeFilter, callback: ChangeCallback) → SubscriptionHandle?

  -- Metadata
  capabilities() → AdapterCapabilities
}
```

`subscribeChanges` is optional: an adapter that cannot push change notifications returns no handle, and the library supplies the durable, at-least-once subscription semantics of §8 over that adapter's polling interface.

**Index management** (`ensureIndex` / `dropIndex`) is deferred to v0.3, where the cost-based query planner will manage index lifecycle. Adapters are not required to expose these methods in v0.2.

**Reference method set.** Beyond the core protocol above, the reference implementation relies on a richer set of adapter methods: an idempotency store (key→result cache for dedup across restarts), an append-only event log (for replay support), and a `maxRecordedSeq()` accessor (returns the highest recorded sequence number, used by the replay engine to detect gaps). These are implementation contracts between the library core and the bundled adapters; third-party adapters need not implement them unless they intend to support the full replay/idempotency features.

### 10.1 Standard adapters

- **SQLite** — embedded; single-writer; cheap for solo deployments.
- **Postgres** — networked; multi-writer; production-grade.
- **DuckDB** — analytical; column-oriented; good for time-series and aggregations.
- **Vector indices** (Chroma, Qdrant, etc.) — for similarity-heavy access patterns.
- **Hybrid** — composes multiple adapters with the library routing query parts to the appropriate stores.

Adapters declare their capabilities (`AdapterCapabilities`) so the query optimizer can choose execution plans accordingly. An adapter that supports semantic search natively (Chroma) will be routed similarity queries; an adapter that doesn't (SQLite) will fall back to in-memory similarity over filtered candidates.

### 10.2 Value-predicate support

Value-predicate support is a per-(adapter, predicate-kind) capability, not a single per-adapter flag. Different predicate kinds have different indexing characteristics even within the same adapter — Postgres indexes equality and containment via GIN but falls back to scans for regex. The adapter capability surface therefore carries a per-kind map:

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
  | unsupported              -- the library rejects queries containing this predicate kind
```

The six `PredicateKind`s correspond directly to the value-predicate forms of the selection operator σ (§4.2): the path/whole-value equality, comparison, set-membership, regex, structural-pattern, and null/existence predicates declared there.

Reference adapter capability matrix:

| Adapter | equality | range | set_membership | regex | structural | null_check |
|---|---|---|---|---|---|---|
| Postgres (JSONB+GIN) | native_indexed | native_unindexed* | native_unindexed | native_unindexed | native_unindexed | native_indexed |
| DuckDB | native_indexed | native_indexed | native_indexed | native_unindexed | native_unindexed | native_indexed |
| SQLite | fallback_in_memory | fallback_in_memory | fallback_in_memory | fallback_in_memory | fallback_in_memory | fallback_in_memory |
| ChromaDB | fallback_in_memory | fallback_in_memory | fallback_in_memory | fallback_in_memory | fallback_in_memory | fallback_in_memory |
| Markdown vault | fallback_in_memory | fallback_in_memory | fallback_in_memory | fallback_in_memory | fallback_in_memory | fallback_in_memory |

*Postgres range queries on JSONB paths can be indexed via expression indexes (`CREATE INDEX ... ON corpus ((value->>'amount')::numeric)`) but require explicit setup per path.

†SQLite value-predicate push-down via JSON1 (→ `native_unindexed`) is a v0.3 optimization. In v0.2 the library retrieves candidates and filters all value predicates in memory (`fallback_in_memory`).

The query optimizer chooses an evaluation strategy per predicate kind and per adapter:

- `native_indexed`: push the predicate to the adapter, accept index cost.
- `native_unindexed`: push the predicate to the adapter, accept full-scan cost.
- `fallback_in_memory`: retrieve candidates via indexed predicates first, filter the unindexed value predicates in memory; emit a warning if the working set is large.
- `unsupported`: reject the query before returning results (the reference implementation checks adapter capabilities at query-evaluation entry).

**Important consumer-facing implication:** reading "Postgres supports `native_indexed` value predicates" as "all value predicates are cheap on Postgres" is wrong. Postgres equality on JSONB paths is fast; regex on the same paths is a full scan. Production query planning MUST consult the per-kind matrix, not just the adapter summary.

Consumers should structure queries to use indexed predicate kinds where possible. A logical filter that can be expressed as either equality or regex should use equality. A logical filter that requires regex should expect scan performance regardless of adapter.

Consumers MUST be informed of fallback-mode costs. Production queries against `fallback_in_memory` adapters that retrieve large working sets are operational hazards and should be visible in query plan output. The library delivers these warnings via an `onWarning` callback registered on the query context; consumers that do not register a callback receive warnings as structured log entries. Queries containing `unsupported` predicate kinds are **rejected before returning results** — the library raises an error at query-evaluation entry so consumers receive a clear failure rather than silently incomplete results.

### 10.3 Backend choice guidance

The fallback-mode classification means backend choice matters. Guidance for consumers:

| Workload pattern | Recommended adapter |
|---|---|
| Value-predicate-heavy (structured data filtering) | Postgres or DuckDB |
| Similarity-heavy (semantic retrieval) | Vector DB |
| Mixed structured + similarity | Hybrid adapter with routing |
| Low-volume, human-edited artifacts | Markdown vault (Stoa-style) |
| Embedded, single-process | SQLite |

Choosing a similarity-optimized adapter for a structured-query workload, or vice versa, produces queries that work correctly but perform pathologically. The optimizer cannot fix a backend-choice mismatch.

### 10.4 Synchronous and asynchronous adapter profiles

The `StorageAdapter` protocol above is the **synchronous embedded profile** (returns values directly; the reference implementation is SQLite over a blocking driver). A parallel **asynchronous server profile**, `AsyncStorageAdapter`, exists for networked, multi-writer backends: it is a member-for-member mirror in which every storage method returns a `Promise`, `transaction` takes an explicit `corpusId` and an async body, and `capabilities()` remains synchronous (static metadata). Both profiles share one set of value types (`ClaimEvent`, `ExecutionPlan`, `AdapterCapabilities`, `IdempotencyRecord`, …), so the two contracts cannot drift. The reference asynchronous adapter is Postgres over `pg`.

The query algebra (§4) is **backend-agnostic** because I/O is confined to a small, enumerated set of seams — the `leaf` load, the provenance-traversal (γ) claim lookups, and the binary operators' sub-pipeline evaluation. Every other operator is a pure `Corpus → Corpus` transform. The asynchronous evaluation path awaits those seams and reuses the identical pure operator cores; it does not re-implement the algebra. A conformance suite runs one backend-agnostic contract against both profiles, and a parity harness asserts the two backends produce identical served claims and bit-identical confidence for the same inputs.

**Multi-tenant isolation composes *around* corpus isolation.** The per-corpus `scoped()` boundary (§6, §9) is unchanged. On top of it, a `TenantRouter` resolves a tenant identity to a scoped connection via one of three mechanisms, none of which trusts caller-supplied input — the same bypass-proof property as `scoped()`:

- **Schema-per-tenant** — schema-qualified identifiers built from a validated allow-list (never `SET search_path` on a pooled connection, whose session state can leak across tenants).
- **Database-per-tenant** — a per-tenant connection pool.
- **Row-level** — a `tenant_id` column (in the base schema, `NOT NULL DEFAULT ''`) that the adapter stamps on every write and filters on every read across all four tables; the per-corpus advisory lock composes tenant + corpus, so tenants may share a corpus namespace and still get separate, non-forking audit chains. Non-row-level providers leave `tenant_id = ''` and rely on routing.

Corpus isolation and tenant isolation are independent, composable enforcement layers.

**Hash-chain serialization is a per-corpus write invariant.** The append-only event log (§7, used by replay and audit) maintains a per-corpus hash chain: each entry hashes its canonical event plus the prior entry's hash. Correctness requires that concurrent writers to the same corpus serialize, so no writer computes its entry from a stale chain head. The synchronous SQLite profile achieves this with `IMMEDIATE` transactions (single writer). The asynchronous Postgres profile achieves it with a **lock-first per-corpus advisory transaction lock** — `pg_advisory_xact_lock` keyed on the corpus, acquired before any chain/claims read — under `READ COMMITTED` isolation (sufficient, because the xact lock releases at COMMIT and a waiting writer's post-lock head read takes a fresh snapshot). The lock is keyed per corpus, so writers to different corpora (and different tenants) never contend, and `recordedSeq` is monotonic per corpus.

---

## 11. Worked queries

This section presents six worked queries that constrain the spec. Each is expressed in the algebra of §4 and the write/subscription model of §7–§8, and demonstrates specific operators or interactions. All queries use the corrected operator and rule names of this consolidated spec: string literals are quoted, combination rules use their post-split names (`rule_weighted_avg`, `rule_evidence_pooled`, `rule_max_mean`, `rule_max_concentration`; the ambiguous v0.1 `rule_max_confidence` is deprecated and removed, §5.6), and the aggregation/distribution families compose as specified in §4.13.

### 11.1 Query 1 — context assembly for architecture review

**Scenario.** A workflow's compile step needs to assemble context for an architecture-review subtask on the Canopy lineage-block work. Find claims about the lineage-block design that are currently believed, semantically similar to the query, not contradicted by higher-confidence claims, with full evidence chains, formatted as a 12k-token XML context.

```
let corpus_now     = τ_now(corpus("workspace:canopy"))
let scoped         = σ_subject="lineage-block" (corpus_now)
let decayed        = δ_exponential(half_life=30d) (scoped)
let validated      = σ_status="validated" ∧ confidence>0.7 (decayed)
let contradictions = ⊥(validated)
let resolved       = resolve_deprecate_lower(contradictions, validated)
let ranked         = ρ_cosine, "lineage block schema considerations" (resolved)
let with_evidence  = γ_2(ranked)
let composed       = κ_xml, 12000_tokens (with_evidence)
return composed
```

Demonstrates: temporal slicing (§4.4), decay (§4.5), confidence filtering (§4.2), contradiction detection and resolution (§4.8, §7.3), similarity ranking (§4.6), provenance traversal (§4.7), composition (§4.12).

### 11.2 Query 2 — multi-corpus layered retrieval

**Scenario.** A backend subagent is invoked for a NestJS task in CrewTracks. Assemble context from general NestJS knowledge, CrewTracks-specific NestJS knowledge, and the backend-role tag-scoped claims, with layered-override semantics so the more-specific corpus wins on key collisions.

```
let nestjs_base   = δ_default(τ_now(σ_status="validated" ∧ confidence>0.6 (corpus("wiki:nestjs-general"))))
let crewtracks    = δ_default(τ_now(σ_status="validated" ∧ confidence>0.6 (corpus("wiki:crewtracks-modules"))))
let backend_role  = δ_persona(τ_now(σ_status="validated" ∧ confidence>0.5 (σ_tag="role:backend" (corpus("default")))))

let layered_kb    = crewtracks ⊳ nestjs_base
let with_role     = backend_role ⊳ layered_kb

let ranked        = ρ_cosine, task_query (with_role)
let with_evidence = γ_2(ranked)
let composed      = κ_xml, 12000_tokens (with_evidence)
return composed
```

Demonstrates: multi-corpus queries, the layered-override operator ⊳ (§4.10), per-corpus decay and confidence settings, role-as-tag (not role-as-entity). Under ⊳ the rightmost-applied operand (`backend_role`) overrides on matching `(subject, key, scope)`, with `crewtracks` overriding `nestjs_base`.

### 11.3 Query 3 — time-traveling synthesis with derived write

**Scenario.** A weekly project-margin check. For project Lincoln Street, determine whether risk has elevated meaningfully between four weeks ago and one week ago. If so, write a derived `at-risk` claim with full provenance.

```
let project       = "lincoln-street"
let week_ago      = now() - 7d
let month_ago     = now() - 28d
let recent_cutoff = now() - 72h

let signals_week  = σ_subject∈{"cost-variance", "schedule-slip", "quality-issue"} ∧ status="validated" (
                      τ_known(week_ago) (σ_scope.entityId=project (corpus("workspace:acme")))
                    )

let signals_month = σ_subject∈{"cost-variance", "schedule-slip", "quality-issue"} ∧ status="validated" (
                      τ_known(month_ago) (σ_scope.entityId=project (corpus("workspace:acme")))
                    )

let risk_week     = ⊕_synthesize_as<"at-risk", "project.risk-elevation">_rule_evidence_pooled (signals_week)
let risk_month    = ⊕_synthesize_as<"at-risk", "project.risk-elevation">_rule_evidence_pooled (signals_month)

let risk_delta    = effective_confidence(risk_week) - effective_confidence(risk_month)

let recent_alerts = σ_subject="at-risk" ∧ scope.entityId=project ∧ recorded>recent_cutoff (corpus("workspace:acme"))

if risk_delta > 0.15 and recent_alerts is empty:
  let derived = derive_claim_from(
    query          = (the synthesis query above),
    target_subject = "at-risk",
    target_key     = "project.risk-elevation",
    scope          = { entityId: project, workspace: "acme" },
    combination    = rule_evidence_pooled
  )
  commit_derived(
    candidate        = derived,
    provenance_query = serialize(synthesis_query),
    corpus_state     = current_state(),
    policy           = reject_on_contradiction
  )
```

Demonstrates: bitemporal time-travel via `τ_known` (§4.4), belief synthesis via `⊕_synthesize_as` with the post-split `rule_evidence_pooled` rule (§4.9, §5.6), the algebra-to-computation boundary (arithmetic over derived effective-confidence values), and derived writes with full provenance via `derive_claim_from` / `commit_derived` (§7.6).

### 11.4 Query 4 — streaming subscriptions

**Scenario.** An architecture-review-panel run `R` is active. Three subscriptions need to fire reactively as the corpus evolves during the run, each with a distinct trigger and delivery target.

```
-- Subscription 1: push panel insights to Brett's Pilot session
subscribe(
  query     = σ_subject="panel-insight" ∧ scope.runId=R ∧ confidence>0.7 (corpus("workspace:canopy")),
  trigger   = on_every_match,
  target    = mcp_channel(serverId="pilot", channelId="lineage-block-discussion"),
  lifecycle = until_event(workflow_completed(R))
)

-- Subscription 2: alert orchestrator on contradictions appearing in the run
subscribe(
  query     = ⊥(σ_status="validated" ∧ scope.runId=R (corpus("workspace:canopy"))),
  trigger   = on_transition(direction=to_nonempty),
  target    = webhook("https://orchestrator/run-contradiction"),
  lifecycle = until_event(workflow_completed(R))
)

-- Subscription 3: audit-log every claim written during the run
subscribe(
  query     = σ_scope.runId=R (corpus("workspace:canopy")),
  trigger   = on_every_match,
  target    = log_sink(corpusId="audit:run-events"),
  lifecycle = until_event(workflow_completed(R))
)
```

Demonstrates: three trigger semantics (`on_every_match`, `on_transition(direction=to_nonempty)`; §8.2), three delivery target types (`mcp_channel`, `webhook`, `log_sink`; §8.4), and lifecycle policies tied to corpus events via `until_event` (§8.7). All three queries are over streamable operators (σ, ⊥; §8.3), so the subscriptions evaluate incrementally.

### 11.5 Query 5 — atomic workflow-completion writes

**Scenario.** An architecture-review-panel run completes. Multiple claims must be written atomically — per-agent panel insights, a synthesized decision derived from those insights, a run summary, and an audit event.

```
transaction {
  -- Per-agent panel insights
  for agent_output in run_outputs:
    for insight in extract_insights(agent_output):
      commit_candidate(
        Claim {
          subject    = "panel-insight",
          key        = "review.lineage-block.insight",
          scope      = { runId: R, persona: agent_output.persona },
          value      = insight.content,
          confidence = beta_from_raw(insight.raw_confidence, source="llm"),
          valid      = [now, ∞),
          source     = "llm",
          provenance = { workflow: "architecture-review-panel", run: R, persona: agent_output.persona },
          evidence   = insight.evidence_refs
        },
        policy = accept_but_mark
      )

  -- Synthesized decision (derived from the insights just written, in this same transaction)
  let decision_query     = ⊕_synthesize_as<"decision", "review.lineage-block.verdict">_rule_weighted_avg (
                             σ_subject="panel-insight" ∧ scope.runId=R (corpus("workspace:canopy"))
                           )
  let decision_candidate = derive_claim_from(
    query          = decision_query,
    target_subject = "decision",
    target_key     = "review.lineage-block.verdict",
    scope          = { runId: R },
    combination    = rule_weighted_avg
  )

  commit_derived(
    candidate        = decision_candidate,
    provenance_query = serialize(decision_query),
    corpus_state     = current_state(),
    policy           = reject_on_contradiction
  )

  -- Run summary
  commit_candidate(
    Claim {
      subject    = "run-summary",
      key        = "workflow.architecture-review-panel.summary",
      scope      = { runId: R },
      value      = { participants: [...], duration: ..., consensus_level: ... },
      confidence = beta_from_raw(1.0, source="workflow"),
      valid      = [now, ∞),
      source     = "workflow",
      provenance = { workflow: "architecture-review-panel", run: R }
    },
    policy = always_accept
  )

  -- Audit event
  commit_candidate(
    Claim {
      subject    = "audit-event",
      key        = "workflow.run.completed",
      scope      = { runId: R, workspace: "canopy" },
      value      = { final_state: "consensus_reached", claim_count: counts },
      confidence = beta_from_raw(1.0, source="workflow"),
      valid      = [now, now],
      source     = "workflow",
      provenance = { workflow: "architecture-review-panel", run: R }
    },
    policy = always_accept
  )
}
```

Demonstrates: transactional batch writes (§7.4), per-claim contradiction policies (`accept_but_mark`, `reject_on_contradiction`, `always_accept`; §7.3), derived writes within transactions (§7.6), and intra-transaction references — the decision synthesis reads the panel insights committed earlier in the same transaction, while its derivation provenance records the pre-transaction corpus state (§7.4). The decision is synthesized with `⊕_synthesize_as` under `rule_weighted_avg` (the corrected post-split name; §4.9, §5.6).

### 11.6 Query 6 — win-rate reweighting

**Scenario.** A sales-app context assembly that must rank recommended actions not by raw win rate but by a confidence-aware Wilson lower bound, so that a well-evidenced action is not unseated by a lucky one-off. This is the pressure-test query that the retrieval-only algebra could not express; the aggregation family (§4.13) and the bridge operator make it expressible.

```
let actions  = σ_subject="action" ∧ key="action.recommended" (corpus("sales-app"))
let outcomes = σ_subject="action" ∧ key="action.outcome"     (corpus("sales-app"))

-- Compute a Beta-typed win-rate per action, excluding pending/null outcomes
let win_betas = α_groupBy<scope.actionId,
                          binary_rate<value.won>>(outcomes)

-- Rank candidate actions by base similarity
let ranked = ρ_cosine, current_context (actions)

-- Reweight by the Wilson lower bound, which penalizes small samples
let reranked = α_join_aggregate<scope.actionId,
                                groupKey,
                                reweight_wilson_floor>(ranked, win_betas)

-- Compose the final context
let composed = κ_xml, 12000_tokens (reranked)
return composed
```

`binary_rate<value.won>` emits a `Beta(α=r+a·W, β=s+(1−a)·W)` aggregate per group (§5.6), so `reweight_wilson_floor` has a distribution to compute a lower bound over — it is not reweighting a bare ratio. The action with **22/30 wins (Wilson lower bound ≈ 0.55)** correctly outranks the action with **1/1 win (Wilson lower bound ≈ 0.21 at 95% confidence)**. Sample size is respected: even though 1/1 has a higher point estimate (1.0 > 0.73), the Wilson lower bound penalizes the small sample, and the well-evidenced 22/30 action wins. The aggregation family composes with the distribution family.

If the outcome domain had three values (`won`, `lost`, `pending`) and the denominator needed to be controlled explicitly:

```
let win_betas = α_groupBy<scope.actionId,
                          rate<num: value.won = true,
                               denom: value.won = true ∨ value.won = false>>(outcomes)
```

This excludes pending outcomes from both numerator and denominator — they do not count as losses, but they also do not dilute the rate.

Demonstrates: Beta-typed rate aggregation via `α_groupBy` with `binary_rate` (§4.13, §5.6), the aggregation-to-ranking bridge via `α_join_aggregate` with `reweight_wilson_floor` (§4.13), and the composition of the aggregation family with the distribution family — confidence-aware ranking that the retrieval-only algebra could not express.

---

## 12. Glossary

**Aggregate result** — a typed terminal value (`AggregateResult`) produced by the aggregation operators (§4.13); a map from group key to aggregate value, where the `rate` variant emits a `Beta` rather than a raw ratio so sample-size uncertainty is preserved.

**Algebra** — the set of typed operators and equational laws that define legal query expressions.

**Bitemporal** — having two distinct time dimensions: valid-time (when the claim's content was true) and transaction-time (when the claim entered the corpus).

**Candidate claim** — a claim that has been emitted but not yet promoted to the corpus.

**Claim** — the basic unit of typed data in a corpus; an assertion with confidence, scope, provenance, and evidence.

**Composition** — the terminal operator family that produces an LLM-ready context document from a ranked corpus.

**Contradiction cluster** — the n-way representation of a disagreement (`ContradictionCluster`) produced by `⊥_clusters` (§4.8): for a single `(subject, key, scope)` triple it groups the conflicting claims by value, preserving disagreement structure that the pairwise form loses.

**Corpus** — a named, schema-bound, access-controlled collection of claims.

**Decay** — confidence adjustment as a function of time, applied at query time rather than write time.

**Derived claim** — a claim produced by a query expression, with the query and corpus state recorded as provenance.

**Distribution protocol** — the `DistributionProtocol<T>` interface (§5.1) that binds a `DistributionType` to its serialization, statistics, conversion, and combination operations; the protocol-tier contract through which Beta, scalar, Dirichlet, Gaussian, and Kalman distributions are supported.

**Effective confidence** — the post-decay, post-weighting confidence used in queries; distinct from raw stored confidence.

**Evidence reference** — a pointer from a claim to a supporting source (another claim, a document, an external resource).

**Provenance** — the structured record of where a claim came from (workflow, run, persona, derivation query).

**Scope** — dynamic context qualifying a claim's static key (workflow ID, entity ID, persona ID, etc.).

**Streamable operator** — an operator that can be evaluated incrementally on each new write in O(1) or O(log n) time.

**Subject** — the top-level namespace component of a claim's key (e.g., `user`, `repo`, `workflow`).

**Subjective-logic opinion** — the `(belief, disbelief, uncertainty, base_rate)` representation a Beta(α, β) confidence maps to via the bridge of §2.5, under the §0.3 convention; its projected probability `α/(α+β)` agrees with the Beta effective mean by construction.

**Subscription** — a long-running query registered against the corpus, with trigger semantics that determine when to deliver notifications.

**Tier** — the three-level classification (§0.2) that every operator, type, and capability carries: **Core `[C]`** (MUST be supported by all implementations), **Protocol extension `[P]`** (exposed through a declared protocol with a reference implementation, opt-in), and **Customer-gated profile `[Prof]`** (specified architecturally but shipped only when a customer requirement justifies it).

**Transaction** — an atomic batch of writes that become visible together or not at all.

---

## Appendix A — Source-weight and decay defaults

The following corpus-level defaults pair each claim source with a source weight and a default decay half-life. Individual corpora MAY override these per their schema.

| Source        | Weight | Half-life (decay default) | Notes                      |
|---------------|--------|---------------------------|----------------------------|
| manual        | 1.3    | 180 days                  | Explicit user input        |
| verification  | 1.2    | 90 days                   | Verified from tests/build  |
| workflow      | 1.0    | 60 days                   | Standard workflow output   |
| heuristic     | 0.9    | 30 days                   | Deterministic extraction   |
| llm           | 0.7    | 14 days                   | LLM inference              |
| imported      | 0.6    | 60 days                   | External sources           |

### A.1 Pseudocount guidance for scalar-to-Beta conversion

When converting a scalar confidence to a Beta distribution (§5), the pseudocount controls how much evidence the scalar is treated as carrying. Consumers needing a starting point MAY use the following tiers, keyed to the source's trust level:

- High-trust sources (manual, verification): pseudocount ≥ 10 — treat each scalar as having substantial evidence backing.
- Medium-trust sources (workflow, heuristic): pseudocount ≈ 5.
- Low-trust sources (llm, imported): pseudocount ≈ 2 — treat the scalar as weak evidence.

These tiers are *guidance only*. Consumers should calibrate the pseudocount to their domain.

---

## Appendix B — Standard similarity functions

These are the standard similarity functions referenced in §4.6. Each is registered per corpus in the schema's `similarities` map (§3.2); a corpus's `defaultSimilarityFn` (§3.3) selects the one used for ρ when none is named.

| Function           | Input types     | Output range | Cost           | Notes                            |
|--------------------|-----------------|--------------|----------------|----------------------------------|
| `sim_cosine`       | Vector × Vector | [0, 1]       | O(d) per claim | Requires embedding adapter       |
| `sim_jaccard`      | Set × Set       | [0, 1]       | O(n + m)       | Token sets                       |
| `sim_bm25`         | Text × Text     | [0, ∞)       | O(n)           | Normalized to [0, 1] for ranking |
| `sim_exact`        | Any × Any       | {0, 1}       | O(1)           | Binary match                     |
| `sim_structural`   | Typed × Typed   | [0, 1]       | varies         | Domain-specific; user-defined    |

**`sim_cosine` reference implementation.** The reference implementation is adapter-backed and cache-backed. It depends on an `EmbeddingAdapter` protocol (§4.6) to produce embeddings and reads those embeddings from a pre-populated cache at query time. The warm-up contract is: embeddings for the corpus are computed OUTSIDE query evaluation via an async warm-up step (`warmEmbeddings`); at query time the implementation reads synchronously from the cache and MUST NOT trigger embedding computation. A cache miss at query time is an error (throw) — the caller is expected to have warmed the cache before invoking the operator. The raw cosine similarity is mapped to [0, 1] via `(1 + cos) / 2` so that the output range matches the `SimilarityFn` contract. The cost profile is: high at warm-up (one embedding-model call per uncached claim); O(dim) per pair at query time after the cache is populated, where `dim` is the embedding dimensionality. The embedding-model version is recorded in `embeddingModelVersions` in derivation provenance (§2.7), not in the similarity-function version string (see §4.6 composition note).

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
- `embeddingModelId` — embedding model associated with similarity-based provenance; makes embedding-model attribution queryable as a structured scope, in addition to its inclusion in derivation provenance

Custom scope fields are permitted but MUST NOT shadow these reserved names.

## Appendix D — Mathematical conventions and re-derivations

This appendix documents the explicit re-derivation of every operation that depends on the pinned α, β convention from §0.3. This is a process discipline: convention changes are graph-level, not node-level. Acknowledging a foundational fix at the site where it was first noticed does not establish that every downstream operation is still correct under the changed convention. Re-deriving every dependent node is what prevents the "original bug wearing different clothes" pattern — a corrected convention silently re-introducing the same class of error in an operation that was never re-checked.

### D.1 The convention

From §0.3: `α = r + a·W`, `β = s + (1−a)·W`, where `r` is the positive evidence count, `s` is the negative evidence count, `W` is the non-informative prior weight, and `a` is the base rate. Recommended defaults `W = 2`, `a = 0.5`. **α and β include the prior.**

### D.2 Operations that depend on this convention

For each operation, the table records its specification location in this document and the **derivation** that establishes its correctness under the pinned convention. Each entry shows the derivation, not a bare assertion of correctness — the entries are themselves claims that require verification (see §D.4).

| Operation | Specification location | Re-derivation |
|---|---|---|
| Effective confidence (mean) | §2.4: `α/(α+β)` | ✓ The formula `α/(α+β)` applies under the pinned convention; the *value* is convention-dependent (see §0.3 and the §0.3 migration shift), NOT neutral. The same symbol string `α/(α+β)` evaluates differently under a raw-counts interpretation than under the prior-inclusive interpretation — under raw counts it is `r/(r+s)`, under the pinned convention it is `(r+a·W)/(r+s+W)`. This is precisely why §0.3 had to pin the convention. The mean does NOT enjoy any "prior cancels in the ratio" property — the prior appears in both numerator and denominator but does not cancel, since it is added (`a·W`), not multiplied. |
| SL bridge from Beta | §2.5 | ✓ Derivation: `belief = (α − a·W)/(α+β) = r/(r+s+W)` explicitly subtracts the prior portion `a·W` from α to recover the raw evidence `r` before normalization. Worked example for `Beta(1,1)` under `W=2`, `a=0.5`: `r = 1 − 0.5·2 = 0`, `s = 1 − 0.5·2 = 0`, so `belief = 0`, `uncertainty = W/(α+β) = 2/2 = 1.0` ✓ — the vacuous opinion, as required. |
| SL bridge from Dirichlet | §2.5 (Dirichlet generalization) | ✓ Derivation: generalized formula `belief(xᵢ) = (αᵢ − aᵢ·W)/S`, `uncertainty = W/S` with `S = Σαⱼ`. Vacuous-opinion check: for `Dirichlet(W·a₁, …, W·aₖ)`, `belief(xᵢ) = (W·aᵢ − aᵢ·W)/W = 0` for every singleton, and `uncertainty = W/W = 1.0` ✓. The same prior-subtraction structure as the binary case, applied per category; the `W`-scaling holds for frames with `k > 2`. |
| `rule_evidence_pooled` (Beta) | §5.6 | ✓ Derivation: under the pinned convention, `α₁ + α₂ = (r₁ + a·W) + (r₂ + a·W) = (r₁+r₂) + 2·a·W` — naive summation accumulates *two* priors. Subtracting one prior-`W` worth gives `(r₁+r₂) + a·W`, the correct prior-inclusive form for the pooled evidence (exactly one prior retained). Worked example: `Beta(3,2) + Beta(3,2)` under `W=2`, `a=0.5` → `α_pooled = 3+3−1 = 5`, `β_pooled = 2+2−1 = 3`, i.e. `Beta(5,3)` ✓. |
| `rule_evidence_pooled` (Dirichlet) | §5.3, §5.6 | ✓ Derivation: same as Beta, generalized to `k` categories. Pooling `N` inputs accumulates `N` priors (`Σ over inputs of aᵢ·W` per category); subtract `N−1` priors' worth to retain exactly one. The pooled vector adds the per-category raw counts `rᵢ = αᵢ − aᵢ·W` and re-applies a single prior, rather than naively summing `αᵢ`. §5.3 specifies the prior-`W` subtraction explicitly. |
| `rule_weighted_avg` (Beta) | §4.9, §5.6 | ✓ Derivation: weights sum to one (`w₁+w₂=1`), so `w₁α₁ + w₂α₂ = w₁(r₁ + a·W) + w₂(r₂ + a·W) = (w₁r₁ + w₂r₂) + (w₁+w₂)·a·W = (w₁r₁ + w₂r₂) + a·W`. Exactly one prior carries through because the weights sum to one. This single-prior-preserving structure — distinct from pooling, which accumulates priors and needed the §5.6 correction — is what makes averaging well-behaved across inputs sharing the same convention. |
| `rule_weighted_avg` (Dirichlet) | §5.3, §5.6 | ✓ Derivation: same as Beta, generalized to `k` categories. `Σⱼ wⱼ·α_{ij} = Σⱼ wⱼ·(rᵢ + aᵢ·W) = (Σⱼ wⱼ·rᵢ) + aᵢ·W` since `Σⱼ wⱼ = 1`. One prior carried through per category. **Idempotent ✓** (averaging a vector with itself returns the vector). |
| `rule_weighted_avg` (Gaussian) | §5.4 | ✓ Gaussian operations do not depend on the Beta convention. The moment-matched mixture math of §5.4 is convention-independent because a Gaussian `(μ, σ²)` has no prior-vs-evidence decomposition — there is no `a·W` term to retain or double-count. The de-aliasing of §5.4 keeps `rule_weighted_avg` idempotent for Gaussian inputs, consistent with Beta/Dirichlet/scalar. |
| `rule_max_mean` (all types) | §5.6, §4.9 | ✓ Derivation: selects the input maximizing `α/(α+β)` (or top-category projected probability for Dirichlet). The ratio's *value* is convention-dependent (per the mean row above), but the *ordering* under a single pinned convention is well-defined. **Counter-example — the ordering is NOT convention-neutral:** take `Beta(8,0)` and `Beta(2,0)` (using raw counts `r=8,s=0` and `r=2,s=0`). Under raw counts both have mean `8/8 = 1.0` and `2/2 = 1.0` — tied. Under the pinned prior-inclusive convention (`W=2`, `a=0.5`, so add `a·W=1` to each α and `(1−a)·W=1` to each β) they become `Beta(9,1)` and `Beta(3,1)` with means `9/10 = 0.9` and `3/4 = 0.75` — the first strictly wins. The ordering itself flips between tied and strict, so `rule_max_mean` is well-defined only within a single fixed convention; cross-implementation comparison requires both sides to use the same convention. |
| `rule_max_concentration` (all types) | §5.6, §4.9 | ✓ Derivation: selects the input maximizing `α+β` (Beta) or `S = Σαⱼ` (Dirichlet). The convention adds the same constant `W` to every input's concentration (`α+β = r+s+W` prior-inclusive vs `r+s` raw counts). Adding an identical constant to every candidate preserves their ordering. So the *ordinal* result is genuinely convention-neutral; only the *absolute* concentration value is convention-dependent. (Contrast `rule_max_mean`, where the convention shift is not a uniform additive offset and the ordering can change — see the counter-example above.) |
| `rule_dempster` (via SL bridge) | §2.5, §5.6 | ✓ Derivation: Dempster's rule operates on mass functions; mass functions are derived from SL opinions via the §2.5 bridge; SL opinions are derived from Beta/Dirichlet via §2.5's prior-subtracting formulas. Convention-correctness propagates through the chain because each conversion step uses the corrected (prior-aware) formulas; the combination itself never touches α, β directly. The correctness of `rule_dempster` therefore reduces to the correctness of the bridge rows above. |
| `rule_kalman` (Gaussian) | §5.4 | ✓ Gaussian operations do not depend on the Beta convention. Kalman fusion operates on `(μ, σ²)`, which has no prior-vs-evidence decomposition. Convention-independent. (Note `rule_kalman` is precision-weighted and distinct from the trust-weighted `rule_weighted_avg`, per §5.4 — but that distinction is orthogonal to the α, β convention.) |
| `scalar_to_beta` conversion | §5.5, §A.1 | ✓ Derivation: the formula `α = scalar·pseudocount + a·W` explicitly constructs a prior-inclusive Beta. The `scalar·pseudocount` term is the raw-evidence contribution (treating the scalar as the expectation over `pseudocount` observations, so `r = scalar·pseudocount`); the `a·W` term adds the prior. The result satisfies `α + β = pseudocount + W`, which has the correct prior-inclusive structure — exactly one prior of weight `W` on top of `pseudocount` worth of raw evidence. |
| `α_rate` (aggregation) | §4.13 | ✓ Derivation: emits `Beta(r + a·W, s + (1−a)·W)` where `r`, `s` are the observed numerator/denominator-minus-numerator counts and `W`, `a` come from the corpus's pinned values. By construction it follows the convention. §4.13 explicitly rejects Laplace `+1/+1` smoothing, which would add a fixed pseudocount regardless of the corpus's `W` and thereby break the convention for any corpus that overrides `W`. |
| `extend_to_frame` (Beta → Dirichlet) | §5.5 | ✓ Derivation given in §D.3 below. |

### D.3 `extend_to_frame` derivation

The original `extend_to_frame` formula carried the Beta's prior into the target frame without renormalization, which was internally inconsistent whenever `a_binary ≠ a_A` or `W_binary ≠ W_target`. The §5.5 specification strips the Beta's prior to recover raw counts, then redistributes that raw evidence under the target frame's own prior structure.

Derivation. An input `Beta(α, β)` with binary prior `(W_b, a_b)` decomposes into raw counts `r = α − a_b·W_b` and `s = β − (1 − a_b)·W_b`. Under a target frame `{A, B, C}` with base rates `(a_A, a_B, a_C)`, prior weight `W_t`, and `trueMapsTo = A`:

- `α_A = r + a_A·W_t` — the Beta's "True" evidence `r` goes to `A`; `A`'s prior is added.
- `α_B = s·(a_B/(1−a_A)) + a_B·W_t` — the Beta's "False" evidence `s` splits across the non-A categories proportionally to their base rates; `B`'s prior is added.
- `α_C = s·(a_C/(1−a_A)) + a_C·W_t` — analogous for `C`.

Properties (derived, not asserted):

- *Raw-evidence preserving.* `Σα_i − Σ(aᵢ·W_t) = r + s·(a_B + a_C)/(1−a_A) = r + s·((1−a_A)/(1−a_A)) = r + s`. ✓ The total raw evidence count is invariant — the redistribution moves `s` among the non-A categories but neither creates nor destroys evidence.
- *Prior-structure consistent.* Each category contributes `aᵢ·W_t` to the total concentration; the prior sum is `Σaᵢ·W_t = W_t` (since `Σaᵢ = 1`). The result has a uniform prior weight `W_t`, matching the target frame's declared base rates regardless of the input Beta's prior.
- *Total concentration.* `Σα_i = (r + s) + W_t = (α + β) + (W_t − W_b)`. This equals `α + β` only when `W_t = W_b`; the worked example in §5.5 shows apparent exact equality solely because both `W`'s were 2. Mass-preservation applies to *raw evidence*, with this conditional caveat for total concentration.
- *Round-trip.* Marginalizing back to a binary frame `{A, ¬A}` gives `Beta(α_A, α_B + α_C) = Beta(r + a_A·W_t, s + (1−a_A)·W_t)`. This equals the input Beta exactly when `(a_b, W_b) = (a_A, W_t)`; otherwise it recovers the input's raw evidence `(r, s)` re-paired with the target frame's prior structure — the operation's intended renormalization, not a defect.

### D.4 Process commitment for future revisions

Future revisions that pin or correct a foundational convention MUST include a §D-equivalent convention-propagation check, listing every operation that depends on the changed quantity, with a re-derivation documented for each. Acknowledging review findings node-by-node is not sufficient when the convention change is graph-level: a node-level fix proves only that one site is correct, while a convention change can re-break any unaudited dependent.

**Additionally, each entry in the propagation table MUST show its derivation — not a hand-waved assertion.** A prior review caught a false justification ("prior cancels in the ratio") sitting in the very table built to enforce rigor; the prior does not cancel, because it is additive, not multiplicative (see the mean row in §D.2). The lesson: the table's own entries are themselves claims that need verification. A justification that asserts neutrality MUST show *why* the operation is neutral, not merely declare it — and an operation whose value is convention-dependent (the mean, `rule_max_mean`) MUST say so rather than borrow the neutrality of operations that genuinely are convention-invariant (`rule_max_concentration`, the Gaussian rules).

This discipline is heavier than reconciling individual review findings, but it catches the class of error that audit-by-name misses. A convention-pinning that had run this check at the time would have caught, proactively, both the carried-prior inconsistency in `extend_to_frame` and the false "prior cancels" justification — each surfaced later as a separate finding precisely because the table entry recorded a conclusion without its derivation.

---

## Appendix E — Design decisions and rationale

This appendix records the reasoning behind the major design decisions in this specification. It exists so that future revisions understand *why* a choice was made, not merely *what* the choice was. Each decision below was reached deliberately; the rationale is recorded to prevent a future revision from re-litigating a settled question without the context that settled it.

### E.1 Tiering: capabilities at appropriate commitment levels

Capabilities are tagged by commitment tier — `[C]` core, `[P]` protocol implementation, `[Prof]` customer-gated profile — rather than presented as a flat feature list. The motivation is to keep the riskiest math out of the correctness surface of every implementation that does not need it.

The Beta + scalar machinery is pinned correctly in core. Dirichlet generalizes the Beta math cleanly via the same subjective-logic bridge, so it is a natural protocol extension. Gaussian + Kalman is *categorically different* math — measurement-uncertainty fusion, not subjective-logic belief combination — serving a specific vertical (sensor / measurement domains). Putting all of this in core would force every implementation to carry the correctness burden of math it never invokes. Moving Dirichlet / Gaussian / Kalman to protocol implementations narrows core, lets vertical-specific implementations come from consumers or community, and preserves correctness boundaries.

The tiering also answers the "strategic scope creep" concern raised in early review: the spec does not claim to be a universal AI memory library. It is the typed algebra for enterprise AI orchestration memory with audit-grade provenance. Vertical-specific needs (consumer-scale, regulatory erasure, sensor measurement) are served by appropriate adapter choices, protocol extensions, and customer-gated profiles — each at its appropriate commitment level — rather than by widening core.

A secondary benefit: provenance fields that are dead weight outside orchestration become opt-out rather than mandatory. The tiering structure lets consumers ignore fields they do not use without the spec pretending those fields do not exist.

### E.2 The `rule_max` split: why split rather than pin

The ambiguous `rule_max_confidence` is deprecated and split into two explicitly-named rules — `rule_max_mean` (argmax over the distribution mean) and `rule_max_concentration` (argmax over total concentration). The natural question is: why not just pin `rule_max_confidence` to one semantic and rename later?

Because either pinning silently surprises the consumers who relied on the other interpretation. There is no consumer-friendly default — the two semantics are genuinely different. "Select the highest-position opinion" and "select the most-precise opinion" answer different questions, and neither is the obvious meaning of "max confidence." Splitting now and forcing an explicit choice is the principled fix; the breaking change is the cost of restoring the protocol contract.

This is the same logic that drives the Gaussian de-aliasing in §5.4 (see E.3): when two operations have different semantics, they need different names. Aliasing or silent defaulting collapses real semantic distinctions and creates the conditions for future audit findings. Ambiguous names invite the same audit finding in every future review, so the contract is best served by unambiguous naming both *across* distribution types and *within* a single type.

### E.3 Trust versus precision: why `rule_kalman` ≠ `rule_weighted_avg`

For Gaussian inputs there are two non-trivial combination rules, and the load-bearing design decision is that they are **not** aliases. They answer different questions:

- `rule_kalman` answers: "given two independent measurements of the same fixed quantity, what is the Bayesian posterior?" It weights by precision (1/σ²), reduces variance, and is **non-idempotent** — fusing a measurement with itself fabricates independence that does not exist and halves the variance.
- `rule_weighted_avg` answers: "given two opinions about the same proposition with different source-trust levels, what is the trust-weighted average opinion?" It weights by source trust (the §4.9 source-trust table, not precision), preserves or increases variance, and is **idempotent** — averaging an opinion with itself preserves the opinion.

Combining a high-trust imprecise sensor with a low-trust precise one illustrates the difference: `rule_kalman` weights by precision (the low-trust precise source wins), `rule_weighted_avg` weights by trust (the high-trust imprecise source wins). These produce different means. The choice between them is a domain-modeling decision, not a math choice.

The de-aliasing matters for the protocol contract. The DistributionProtocol exists to provide a uniform rule-name interface across distribution types. If `rule_weighted_avg` collapsed into `rule_kalman` for Gaussians only, a consumer registering a custom distribution type would not know which semantic to implement — trust-weighted averaging (the Beta/Dirichlet contract) or precision-weighted fusion (the Gaussian-aliased version). Keeping them distinct keeps the contract uniform: `rule_weighted_avg` is always trust-weighted opinion averaging; `rule_kalman` is always precision-weighted Bayesian fusion. Each distribution type implements the semantics correctly for its own math, never by aliasing. An earlier draft that aliased the two for Gaussians was a regression — it broke the trust-vs-precision contract *and* contradicted the rule-idempotence table — and the de-aliasing removes that contradiction.

### E.4 The bimodal moment-match caveat

`rule_weighted_avg` for Gaussians returns the moment-matched Gaussian of the trust-weighted mixture: a *unimodal* approximation of what is potentially a *bimodal* mixture. When two trusted sources strongly disagree — roughly when `(μ₁−μ₂)² > σ₁² + σ₂²` — the moment-matched result is a single Gaussian centered in the empty space between the modes with inflated variance. It says "probably around the midpoint, uncertain" when the truth is "A or B, not between."

This is a deliberately documented limitation rather than a hidden one, because it is at odds with the §1 rationale for preserving disagreement structure via contradiction clusters. When the between-means term `w₁w₂(μ₁−μ₂)²` dominates the within-variance terms `w₁σ₁² + w₂σ₂²`, the moment-matched Gaussian misrepresents the shape of the underlying mixture. The decision is to (a) keep the moment-matched rule, because a single summary distribution is what most consumers want, but (b) detect the failure condition at runtime — the reference implementation emits a `bimodal_approximation_warning` when the between-means term exceeds the within-variance terms by 2× or more — and (c) direct consumers toward cluster-style representation (per §1), or toward `rule_kalman` when the sources are genuinely independent measurements of the same quantity.

### E.5 Erasure deferral

Physical erasure was the centerpiece of an earlier v0.2 draft, sequenced first as a regulatory unblocker. On reconsideration it is deferred to a customer-gated profile rather than shipped as a core addition. The review surfaced three serious issues:

1. **Crypto error.** Per-corpus salt is insufficient for low-entropy content domains; HMAC with KMS-held secret keys is required. The earlier crypto-primitive cost estimate (~1 week) was off by 3–4×.
2. **Legal hole.** Under GDPR, a hash of personal data may itself be personal data when re-identification is feasible. For the low-entropy data that typically triggers erasure requests, preserving content hashes may not satisfy Article 17 — the integrity-verifiable reproducibility tier may collapse to unverifiable for exactly the data that needs erasure. Legal counsel is required to determine the right policy per jurisdiction.
3. **Cost underestimate.** Authenticated data structures (Merkle accumulators over a bitemporal multi-backend corpus) are weeks of work, not "1 week of crypto primitives." Realistic total erasure cost is 22–25 person-weeks, not 13.

Combined with the absence of a signed regulated customer in the immediate pipeline, the appropriate response is to defer the implementation while preserving the architectural sketch. This is not capability rejection; it is appropriate sequencing. Building a 22-week regulatory feature carrying significant crypto and legal risk for hypothetical customers is the wrong investment. When a real regulated customer is in the pipeline, erasure should be designed *with their specific regulatory context and legal counsel*, with the proper cost accepted, and shipped then.

The prerequisites that cannot be added retroactively are banked now regardless: mandatory input hashing in derivation provenance, embedding-model and similarity-function version pinning, and evaluation-clock pinning. These let a future erasure feature preserve audit chains and replay determinism for claims committed today, even though current consumers do not need the broader machinery.

### E.6 The α, β migration shift and its three options

The corrected subjective-logic bridge requires the convention that α and β *include* the prior (`α = r + a·W`, `β = s + (1−a)·W`). Implementations of v0.1 that interpreted α, β as raw evidence counts (without prior) are incompatible with the corrected bridge and must migrate: add prior weights to stored α, β values, and update the schema-version tag on affected claims. Implementations that already included the prior are correct and need no claim-data migration.

**Migration is not semantically neutral, and this must be flagged to downstream consumers.** Adding prior weights is a one-time Bayesian shrinkage: every migrated claim's effective confidence shifts toward the base rate, with the magnitude inversely proportional to evidence weight.

Worked example: a claim stored as raw `(8.2, 1.4)` had mean `8.2/9.6 = 0.854`. After adding the symmetric prior (`W=2`, `a=0.5`), it becomes `(9.2, 2.4)` with mean `9.2/11.6 = 0.793`. The shift is about 6 percentage points. A claim with only a few observations shifts much more — raw `(2, 1)` had mean `0.667`; post-migration `(3, 2)` has mean `0.600`.

The consequences propagate: threshold queries (e.g. `σ_{confidence > 0.7}`) reclassify claims, so some that passed pre-migration now fail; confidence-ordering between claims can change, because low-evidence claims shift more than high-evidence ones, so relative ranking is not preserved; and any downstream system that cached or branched on point-estimate confidence values is affected.

Three migration options are available:

1. **Accept the shift** (recommended). The corrected math is more correct; recalibrate downstream thresholds if needed. Implementations choosing this option should communicate the threshold shift to consumers before the migration runs.
2. **Preserve effective confidence at migration.** Choose post-migration (α, β) to preserve each claim's pre-migration mean. This drops uniform prior weight but preserves threshold semantics. Implementations choosing this option should document the per-claim effective `W` explicitly.
3. **Tag and defer.** Mark v0.1 claims with `schema_version=v0.1` and apply the corrected math only to v0.1.1+ claims. This is hard to maintain long-term — the wrong-math interpretation persists — and is discouraged.

---

## Appendix F — Audit reconciliation history

This appendix records the reconciliation of findings from prior specification reviews — the v0.1 pressure-test audit and the six v0.2 audit rounds — together with the process notes accumulated across those rounds. Every material finding is either fixed, addressed, or explicitly deferred with rationale; no finding has been carried forward without reconciliation. The history is preserved because the *pattern* of how findings were resolved (and, in two cases, mis-resolved before being corrected) is itself a source of process discipline.

### F.1 From the v0.1 audit (six pressure-test scenarios)

| Finding | Status |
|---|---|
| Aggregation missing entirely | Addressed — aggregation operators added |
| Value predicates missing | Addressed — value-predicate support added |
| Distribution model rigidity | Addressed — via the DistributionProtocol extension mechanism |
| Physical erasure unsupported | Deferred to a customer-gated profile, with explicit rationale (see Appendix E.5) |
| Pair-only contradictions | Addressed — n-way contradiction clusters added |
| Provenance fields dead weight outside orchestration | Acknowledged; not made worse; addressed via the tiering structure that lets consumers ignore unused fields |

### F.2 From the v0.2 first audit

| Finding | Status |
|---|---|
| A — SL bridge math wrong | Fixed — corrected bridge subtracts the prior |
| B — Dempster associativity claim wrong | Fixed — claim corrected |
| C — α_rate ignores sample size | Fixed — α_rate emits a Beta, not a raw ratio |
| D — GroupBy associativity contradicts type signatures | Removed — claim deleted, not defended |
| E — Kalman non-idempotence unflagged | Fixed — non-idempotence flagged |
| F — scalar→Beta upcasting underspecified | Fixed — pseudocount construction specified |
| G — Salt vs. HMAC error | Acknowledged; full crypto redesign deferred with erasure |
| H — Legal hole on hash preservation | Acknowledged; legal review required before erasure ships |
| I — Authenticated data structure under-costed | Acknowledged; cost re-estimated |
| J — Decay drift contradicts determinism | Fixed — evaluation clock pinned |
| K — Strategic scope creep | Addressed — tiering places capabilities at appropriate commitment levels |
| L — Sequencing optimizes for hypothetical customer | Addressed — erasure deferral waits for a real customer |
| M — Cost estimates omit expensive bits | Re-estimated with realistic numbers |
| N — Value predicates degrade on critical backends | Acknowledged — per-(adapter, predicate-kind) capability matrix added |

### F.3 From the v0.2 second audit

| Finding | Status |
|---|---|
| 1 — `rule_weighted_avg` mismarked non-idempotent | Fixed — properties table corrected; idempotence restored to averaging and max-selection rules |
| 2 — ReplayStatus enum drift | Fixed — `integrity_unknown` added as a distinct state; references made consistent |
| 3 — α, β migration semantic shift unflagged | Fixed — behavioral consequences and three migration options documented (see Appendix E.6) |
| 4 — Wilson lower bound arithmetic wrong (0.025 → 0.21) | Fixed — number corrected |
| 5 — α_rate signature/usage mismatch | Fixed — `α_binary_rate` convenience form added; primary `α_rate` retains its explicit two-argument signature; worked example matches |
| 6 — `native_indexed` overstates regex on Postgres | Fixed — per-(adapter, predicate-kind) capability matrix replaces the adapter-level summary |

### F.4 From the v0.2 third audit

| Finding | Status |
|---|---|
| W=2 default not addressed for large Dirichlet frames | Fixed — scaling note added for k > 2 |
| α_rate Laplace smoothing vs. corpus-W convention conflict | Fixed — α_rate uses the corpus's pinned W and base rate, not Laplace |
| Gaussian `rule_weighted_avg` vs. `rule_kalman` indistinguishable | Initially "fixed" by aliasing — but the aliasing was itself wrong (broke the trust-vs-precision contract and the idempotence table); properly fixed in the fourth audit (see below) |
| Gaussian `rule_max_confidence` (the now-deprecated rule) mislabeled non-idempotent | Fixed — its successors are listed as idempotent; only evidence-combining rules are non-idempotent |
| Beta→Dirichlet "trivial" claim glosses over frame extension | Fixed — same-frame conversion remains trivial; cross-frame requires the explicit `extend_to_frame` operator |
| §6.1 parallelism estimate stale with erasure deferred | Fixed — re-estimated under the erasure-deferral assumption (further refined in the fourth audit) |
| Acceptance criterion circular (v0.1.1 obligations in v0.2 criteria) | Fixed — v0.1.1 release gate separated from v0.2 acceptance |

### F.5 From the v0.2 fourth audit

| Finding | Status |
|---|---|
| Gaussian `rule_weighted_avg` ≡ `rule_kalman` aliasing breaks the idempotence table and the trust-vs-precision contract | Fixed — de-aliased. `rule_weighted_avg` is trust-weighted opinion averaging (idempotent, spread-preserving via the moment-matched mixture); `rule_kalman` is precision-weighted Bayesian fusion (non-idempotent, variance-reducing). The idempotence table is now uniformly true across all distribution types |
| `extend_to_frame` mapping underspecified (composite-set mass not representable in plain Dirichlet) | Fixed — base-rate-split semantic defined explicitly with a worked formula; further refined in the fifth audit (see below) |
| `agreementRatio` formula undefined | Fixed — defined as `largest_group_size / total_claims` |
| §1↔§3 parallelism overstated (multinomial cluster resolution depends on the Dirichlet bridge) | Fixed — binary-core `resolve_synthesize_belief` split from the protocol-tier `resolve_synthesize_belief_multi` (k>2); parallelism estimate updated to reflect the soft edge |
| `rule_max_confidence` semantic ambiguity for multi-category distributions (the rule later deprecated) | Initially "fixed" by quietly committing Dirichlet to concentration — but the fix was incomplete (Beta unpinned, name still misleading); properly fixed in the fifth audit by splitting the rule (see below) |

### F.6 From the v0.2 fifth audit

| Finding | Status |
|---|---|
| `rule_evidence_pooled` for Beta double-counts the prior under the pinned convention | Fixed — convention-propagation correction. Pooling now uses `α_pooled = α₁ + α₂ − a·W`, matching the Dirichlet implementation; N-input generalization documented |
| `rule_max_confidence` ambiguity (mean vs. concentration) — the partial third-audit fix was incomplete | Fixed — split into `rule_max_mean` and `rule_max_concentration`; the ambiguous original name deprecated with a breaking-change migration |
| Moment-matched Gaussian mismodels a bimodal posterior | Fixed — caveat added explaining when the approximation breaks down; library emits `bimodal_approximation_warning` when the between-means term dominates the within-variance terms (see Appendix E.4) |
| `extend_to_frame` carries the Beta prior into the target frame without renormalization | Fixed — the operation now strips the Beta prior and redistributes raw evidence under the target frame's prior structure; raw-evidence-preserving and prior-consistent |
| Convention propagation not systematic (audit-by-name missed `rule_evidence_pooled`) | Fixed — process discipline established: convention changes require an explicit re-derivation table for every dependent operation (see Appendix D) |

### F.7 From the v0.2 sixth audit

| Finding | Status |
|---|---|
| The convention-propagation table contained a false justification ("prior cancels in the ratio" for the mean row) | Fixed — the mean row now correctly states that `α/(α+β)` is convention-dependent in *value*, per the migration shift (Appendix E.6). Discovering the false justification motivated tightening every table entry to include an explicit derivation rather than a hand-waved assertion |
| The `rule_max_mean` row over-claimed convention-neutrality (ordering can flip under different conventions) | Fixed — the row now shows the counter-example (`Beta(8,0)` vs `Beta(2,0)` tie under raw counts, first wins under the prior-inclusive convention) and clarifies that `rule_max_mean` is convention-fixed within an implementation but not cross-convention neutral |
| "Mass-preserving: Σαᵢ = α+β" for `extend_to_frame` overclaimed (true only when W_target = W_binary) | Fixed — the properties bullet was rewritten: "raw-evidence preserving" (r+s invariant) is unconditional; total-concentration equality is conditional on W_target = W_binary. Worked-example annotation updated to flag this |
| Process: table entries are themselves claims requiring verification, not assertion | Fixed — discipline extended so every entry in a propagation table MUST include its derivation, not just the conclusion; applied retroactively so all rows now show derivations |

### F.8 Process notes accumulated across audit rounds

*Third-audit Gaussian fix (initial round) — wrong-direction resolution.* The third audit flagged that `rule_weighted_avg` and `rule_kalman` looked indistinguishable for Gaussian inputs. The initial response aliased them, which collapsed the semantic distinction and contradicted the rule-idempotence table that had just been fixed. The fourth audit caught the regression, and the correction de-aliased the rules. *Lesson: not every "fix" is in the right direction. Re-derivation against the source math — not label-matching against audit-finding names — is what catches wrong-direction resolutions.*

*Fifth-audit convention propagation.* The fifth audit found that `rule_evidence_pooled` for Beta double-counts the prior under the convention pinned earlier. This is the original convention bug surviving in an operator the audit had not named. *Lesson: convention changes are graph-level; audit findings are node-level. Reconciling audit findings by operator name catches the audited operator but not other operators that depend on the same convention yet were never individually flagged. The convention-propagation check (Appendix D) is the process discipline going forward — when a convention is pinned or corrected, every operation that touches the changed quantity must be re-derived, not just the operators the audit named.*

*Fifth-audit `rule_max_confidence` resolution.* The fifth audit also surfaced that the third-audit "fix" for the now-deprecated `rule_max_confidence` had quietly committed Dirichlet to concentration semantics while leaving the rule name suggesting mean and the Beta criterion unpinned. The fifth-audit fix splits the rule, following the same logic that drove the fourth-audit Gaussian de-aliasing: when two operations have different semantics, give them different names. *Lesson: the protocol-uniform-rule-name contract is not only about cross-type uniformity — it is also about unambiguous naming within a single type. Ambiguous names invite the same audit finding in every future review.*

*Sixth-audit table-entry-as-claim.* The sixth audit found that the convention-propagation table — the very artifact built to enforce rigor — contained a false justification and an over-claim. *Lesson: a table entry is itself a claim that requires verification, not a place to record a conclusion without its derivation. Every entry in a propagation table must show *why* an operation is correct under the convention, not merely assert that it is.*

## Appendix G — Deferred and out-of-scope

This appendix is a catalogue, not a design. It records what the specification deliberately does not address, so that the boundary of the normative body is explicit rather than implied. Each item names the gap and the reason for deferral; none of them is sketched here, because committing to a design before the deferral conditions are met would be the scope creep the tiering structure exists to prevent. Items marked *deferred to v0.3* are planned subsystems whose design awaits a stable v0.2 core; items marked *out of scope* are concerns the library deliberately leaves to its consumers or downstream products.

### G.1 Deferred to v0.3

**Federation across deployments.** The specification assumes a single Mneme deployment. Multi-deployment scenarios — one Polis instance per client, queries that span across them, identity and authentication across deployments, cross-deployment query semantics with their attendant latency and consistency questions, and conflict resolution when federated corpora disagree — are unspecified. Federation is deferred to v0.3 because its design depends on a stable single-deployment core that v0.2 is still establishing; designing federation against a moving target would be premature.

**Schema-migration tooling.** Schemas are versioned, but the specification does not define migration semantics in depth. A real system needs explicit migration declaration (how to transform v1 claims to v2), read-time schema coercion (querying older claims under a newer schema), and validation strictness levels (strict, permissive, coerce). This is a sizable subsystem deferred to v0.3, deliberately held back until the v0.2 core is stable so that migration tooling is built against settled type and scope conventions rather than evolving ones.

**Cost models and optimizer internals.** The specification classifies operators by incremental-evaluation behavior but provides no cost models. A real query planner needs per-operator cost functions parameterized by input size and adapter capabilities, estimated-cardinality propagation through query plans, and plan-equivalence detection for plan caching. This is normal query-optimizer work, deferred to v0.3 because it depends on having real workloads to calibrate the cost functions against; modelling cost without representative workloads would produce numbers with no predictive value.

**Distributed multi-writer semantics.** The specification assumes the storage adapter handles multi-writer races through its own transaction primitives (Postgres MVCC, SQLite single-writer). Deployments needing distributed multi-writer semantics require additional design — causal ordering across writers, CRDT semantics for specific operators, and quorum-based commit protocols. This is an extension point that v0.2 supports only through the adapter's transaction primitives; the distributed-systems semantics are deferred to v0.3 rather than specified now.

**Library-itself observability.** The library should eventually expose its own observability surface — metrics, traces, slow-query logs, and subscription health — as a first-class concern, both because operators need it and because it integrates with the broader audit story, since the library's own operations are themselves auditable claims. This surface is deferred to v0.3; v0.2 does not specify it.

### G.2 Out of scope

**Consumer-scale operational specifics.** Operational targets that belong to a deployment rather than to the algebra — latency budgets, write-throughput targets, and similar consumer-scale operational specifics — are acknowledged as out of v0.2 scope. They are properties of a particular hosted offering and its workload, not of the library that is the specified artifact, and so they are left to consumers and downstream products rather than mandated by the specification.

### G.3 Deferred decisions

**Reference-implementation language choice.** Consistent with the implementation-neutral stance of §1.4, the specification mandates no host language: a conforming implementation MAY be written in any language whose type system can express the claim and corpus types. The choice of programming language for the *reference* implementation is therefore a deferred decision tracked separately here rather than fixed in the normative body. Pinning an implementation language prematurely would conflate the contract (the typed algebra and its protocols) with one realization of it, and would contradict the implementation-neutral commitment that lets the specification be conformed to in any suitable language.

## Appendix H — Erasure profile [Prof, DEFERRED]

**Status: specified, NOT shipped.** This appendix preserves the architectural sketch for a customer-gated erasure profile. It is explicitly NOT part of the normative body of this specification: erasure is a `[Prof]` customer-gated profile that is DEFERRED, and no conforming v0.2 implementation is expected to provide it. The sketch is recorded so that the design is not lost, the prerequisites already banked in v0.1.1 are accounted for, and the conditions under which the work would be undertaken are documented as a profile gap rather than a system gap.

### H.1 Architectural sketch (preserved)

The earlier v0.2 draft carried a substantive erasure design, sound at the architectural level, whose implementation has issues requiring customer-specific resolution. The sketch is preserved as follows:

- Erasure is physical removal from primary storage, producing a **Tombstone** record.
- Tombstones preserve metadata (id, schemaVersion, scopeHash, erasure timestamp and reason) but not content.
- Content hashes MAY be preserved as **cryptographic commitments** under HMAC with KMS-held keys, IF legally permissible for the data category.
- Derivation provenance includes input hashes (already mandatory per v0.1.1 — see H.3).
- Replay degrades across **stratified reproducibility tiers**: exact reproduction when inputs are present; integrity-verifiable when inputs are erased but hashes are preserved; acknowledgment-only when the hashes are also erased.

### H.2 The three blocking issues

The v0.1.1 review surfaced three serious issues that block shipping erasure as drafted:

1. **Crypto error — HMAC, not salt.** Per-corpus salt is insufficient for low-entropy content domains; HMAC with KMS-held secret keys is required instead. The earlier draft's cost estimate (~1 week for crypto primitives) was off by 3–4x.
2. **Legal hole — GDPR hash-as-personal-data.** Under GDPR, a hash of personal data may itself be personal data when re-identification is feasible. For low-entropy data — exactly the data that typically triggers erasure requests — preserving content hashes may not satisfy Article 17, and the integrity-verifiable reproducibility tier may collapse to unverifiable for precisely that data. Legal counsel is required to determine the right policy per jurisdiction.
3. **Cost underestimate — 22–25 person-weeks.** Authenticated data structures (Merkle accumulators over a bitemporal multi-backend corpus) are weeks of work, not a single week of crypto primitives. Realistic total erasure cost is 22–25 person-weeks, not the 13 originally estimated.

### H.3 Banked v0.1.1 prerequisites

The v0.1.1 errata bank the prerequisites for future erasure work, recorded now because they cannot be added retroactively:

- **Mandatory input hashing** in derivation provenance: future erasures can preserve audit chains for derivations committed under v0.1.1, even though current consumers do not need the data.
- **Model-version pinning** (embedding-model and similarity-function versions): replay can identify whether the necessary models are still available.
- **`evaluationClock` pinning**: replay is deterministic, with no decay drift.

### H.4 Trigger conditions

The erasure profile is built when at least one of the following becomes true:

1. A regulated customer (GDPR-, CCPA-, or HIPAA-subject) is in the signed or imminent pipeline.
2. Legal counsel has provided jurisdiction-specific guidance on hash-preservation policies.
3. Sufficient engineering capacity is committed for the realistic 22–25 person-week scope.

Until at least one trigger fires, the architectural sketch is preserved, the prerequisite provenance discipline is in place, and the absence of erasure is documented as a profile gap. When a trigger does fire, the work is a 5–7 month, deeply sequential effort (legal review, crypto design against the customer's HMAC/KMS infrastructure, authenticated-data-structure design with a proper cost estimate, implementation per this sketch adjusted for legal findings, and customer-specific compliance documentation) — and customers should be told this honestly.
