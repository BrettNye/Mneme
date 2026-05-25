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

