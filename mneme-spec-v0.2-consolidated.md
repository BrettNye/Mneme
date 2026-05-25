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
  derivedFrom?  : DerivationProvenance             -- if this is a derived claim (see §6)
}

DerivationProvenance {
  queryExpression        : SerializedAlgebraExpression  -- the query that produced this
  corpusState            : LogicalTimestamp             -- corpus state at evaluation
  combinationRule        : string                       -- rule used (if synthesis)
  inputClaims            : Set<ClaimId>                 -- contributing claims
  similarityVersions     : Map<SimilarityFunctionId, Version>  -- versions of similarity fns used
  embeddingModelVersions : Map<EmbeddingModelId, Version>      -- versions of embedding models used
  evaluationClock        : Instant                      -- pinned eval time for time-dependent operators
}
```

Derivation provenance makes derived claims *reproducible*: a consumer can re-run the serialized query against the recorded corpus state and verify they get the same derived claim. This is the audit-grade-provenance guarantee. The reproducibility guarantee is conditional on version availability — replay verifies the result *iff* all input claims are present, all referenced similarity-function and embedding-model versions remain available in the catalog, and the pinned `evaluationClock` is used for time-dependent operators. The full replay-status stratification is specified in §6.

`similarityVersions` records the version of every similarity function used in the query; `embeddingModelVersions` records the version of every embedding model used (e.g., when `ρ_cosine` is invoked, the embedding model's version identifier is captured). `evaluationClock` pins the time at which time-dependent operators (decay, `τ_now`) are evaluated, eliminating "decay drift" during replay — re-evaluation uses the pinned clock, not the current clock.

These three fields are mandatory for any derived write whose query references similarity-based operators, and recording them is *irreversible at write time*: a derivation committed without them cannot retroactively gain them. Implementations MUST begin recording version information immediately, even before the broader replay-verification machinery is built (see §6).

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
  required           : Set<FieldName>                -- which top-level fields are required
  similarities       : Map<ValueTypeId, SimilarityFn>-- registered similarity functions
  scalarPseudocount  : Map<Source, Number>           -- per-source pseudo-count for scalar→Beta coercion
}
```

Schemas declare what *can* exist in the corpus. Writes that do not conform are rejected. Queries reference field names that MUST exist in the schema; a missing field is a query-time error, not a silent empty result. Where a key declares a `valueSchema`, value predicates against that key are type-checked at parse time against the declared structure (see §4).

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

The retrieval operators in §4.2–§4.7 all have signature `Corpus → Corpus` except similarity ranking, which has signature `Corpus → RankedCorpus`. Because most retrieval operators preserve the `Corpus` type, they compose freely; the equational laws below state when that composition commutes or simplifies, which is what an optimizer (§4.13) exploits.

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
- Value predicates compose with the rest of the predicate language and respect these laws: commutativity with other selections holds when the addressed paths are unambiguous, and push-down through joins, temporal slicing, and decay holds for value predicates that do not reference those operators' fields (see §4.13).

**Incremental evaluation.** Streamable. For a new write, check whether the new claim matches `p`; if so, add it to the result. On a deletion (deprecation), remove the claim if it had previously matched. Value-predicate matching is per-claim and so does not change this classification; only its *cost* per write varies by adapter capability (§10).

### 4.3 Projection — π `[C]`

```
π_f : Corpus → Corpus
```

Restrict each claim to the subset of fields specified by `f`. The result is still a corpus, but with thinner claims (some fields elided). Projection is used primarily for token efficiency in composition: when the consumer does not need full claims, projecting early reduces the data flowing through the rest of the pipeline.

**Equational laws.**

- Idempotence: `π_f(π_f(C)) = π_f(C)`.
- Composition: `π_f(π_g(C)) = π_{f ∩ g}(C)` when `f ⊆ g`. Adjacent projections combine into a single projection over the intersection of their field sets (see §4.13).

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

**Equational laws.**

- Monotonicity under selection: `ρ_{sim,q}(σ_p(C))` produces a subset of the rankings of `ρ_{sim,q}(C)` — filtering before ranking yields a subset of the ranking obtained after filtering. (This is the basis for hoisting similarity to after selection in §4.13.)
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
resolve_deprecate_lower : Set<ContradictionPair> × Corpus → Corpus
resolve_flag_for_review : Set<ContradictionPair> × Corpus → Corpus
resolve_keep_both       : Set<ContradictionPair> × Corpus → Corpus
```

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
