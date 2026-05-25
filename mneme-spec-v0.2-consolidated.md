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

