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

