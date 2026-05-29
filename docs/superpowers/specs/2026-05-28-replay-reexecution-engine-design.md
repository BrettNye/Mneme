---
title: Replay Re-execution Engine
created: 2026-05-28
status: design
spec-ref: mneme-spec-v0.2-consolidated.md §7.6
---

# Replay Re-execution Engine — Design

## 1. Problem

The Mneme spec (§7.6) promises *version-conditional reproducibility*: a consumer can
re-run the serialized query that produced a derived claim against the recorded corpus
state and verify the result, **iff** all input claims are present, all referenced
similarity/embedding versions remain available, and the pinned `evaluationClock` is used
for time-dependent operators.

Today this promise is unrealized:

- `DerivationProvenance.queryExpression` is typed `string` but `deriveClaimFrom` always
  writes `""` — the query is never serialized.
- A query is a `Stage<any, any>[]` pipeline of **opaque closures** (`leaf("corpus")`,
  `liftOp(σ…)`, `gammaStage(2)`). Closures cannot be serialized.
- `replayStatus` already implements the degraded paths (`missing_inputs`,
  `unavailable_models`, `integrity_unknown`) but returns `"failed"` as a placeholder
  wherever it should re-execute and confirm `"exact"`.

This slice closes the gap with **full operator coverage**: a serializable algebra AST, a
compiler from AST to the existing executable `Stage[]`, and a re-execution + comparison
path wired into replay.

## 2. Decisions

These were resolved during brainstorming and are fixed for this slice:

1. **Full operator coverage** — the AST covers the entire algebra surface
   (σ, τ×4, δ, π, ρ, κ, γ, ⊕/synthesis, resolution×5, aggregation α-family), not just the
   operators in use today.
2. **AST-primary (compile to run)** — a declarative `ExprNode` tree is the single source
   of truth. Callers author the AST; the engine compiles it to a `Stage[]` for execution,
   and the *same* AST serializes for replay. No parallel representation, no drift. This
   matches the spec's `AlgebraExpression` / `SerializedAlgebraExpression` distinction.
3. **Epsilon-tolerant structural match** — `exact` means the recomputed claim's semantic
   payload (`value` + `confidence` Beta) matches the recorded claim within a small epsilon
   (`1e-9`), tolerating benign floating-point reassociation from input ordering. `exact`
   means *semantically reproduced*, not bit-identical.
4. **`mismatch` status added** — a successful re-execution whose result differs from the
   recorded claim is reported as a new `mismatch` status (distinct from `failed`, which
   means execution itself could not proceed). This is a minor, additive extension to the
   §7.6 `ReplayStatus` enum, flagged for a spec footnote.

## 3. Architecture

The engine follows the codebase's existing **data-ADT + interpreter** idiom — the same
pattern `Predicate` / `matches()` already uses — lifted from predicates to the whole query
pipeline. One declarative `ExprNode` tree drives everything:

```
author ExprNode ──compile(node)──▶ Stage[] ──evaluate(ctx)──▶ Corpus/Claim
        │
        └──serializeExpr(node) = JSON──▶ provenance.queryExpression (string)
                                              │
   replay: parseExpr ──▶ compile ──▶ evaluate(pinned clock) ──▶ compare ──▶ exact | mismatch
```

Because `ExprNode` is plain JSON-able data:

- **serialize** = canonical `JSON.stringify` (stable key order).
- **parse** = `JSON.parse` + structural validation.

No bespoke serializer is needed. The only values that cannot be inlined as data — rule
functions — become **registry-name references**, mirroring the existing
`similarityFn(name)` lookup.

### 3.1 Module layout

| File | Purpose |
|------|---------|
| `src/algebra/ast.ts` | `ExprNode` discriminated union + node constructors |
| `src/algebra/registries.ts` | name→fn registries for combination, synthesis, resolution, reweight, token-counter families (similarity + distribution registries already exist) |
| `src/algebra/compile.ts` | `compile(node): Stage[]` — interpreter mapping each `ExprNode` to its operator closure |
| `src/algebra/serialize.ts` | `serializeExpr(node): string` (canonical) + `parseExpr(string): ExprNode` (validated) |
| `src/write/replay.ts` (extend) | re-execution path + `mismatch` status + epsilon claim comparison |
| `src/write/derive.ts` (change) | takes `ExprNode` instead of `Stage[]`; records the serialized AST |

## 4. The `ExprNode` ADT

A discriminated union covering the full operator surface. Nodes nest via `src` (a tree);
`compile` flattens the tree into the linear `Stage[]` that `evaluate()` already runs.
Function-valued params are either inline data (predicate, decay policy, fields) or a
registry-name reference (similarity fn, combination/resolution/reweight rule, token
counter).

```ts
type ExprNode =
  | { op: "leaf";       corpusId: string }
  | { op: "sigma";      pred: Predicate; src: ExprNode }                         // σ(p)        Corpus→Corpus
  | { op: "tau";        mode: "valid" | "recorded" | "known" | "now"; t?: Instant; src: ExprNode } // τ   Corpus→Corpus
  | { op: "delta";      policy: DecayPolicy; src: ExprNode }                     // δ(policy)   Corpus→Corpus (clock from ctx)
  | { op: "pi";         fields: Field[]; src: ExprNode }                         // π(fields)   Corpus→Corpus
  | { op: "rho";        fn: string; query: Value; src: ExprNode }               // ρ(name,q)   Corpus→RankedCorpus
  | { op: "gamma";      depth: number; src: ExprNode }                           // γ(depth)    RankedCorpus→RankedCorpus
  | { op: "kappa";      fmt: Format; maxTokens: number; dedupThreshold?: number; src: ExprNode } // κ  RankedCorpus→ComposedContext
  | { op: "combine";    rule: string; params?: JsonValue; src: ExprNode }        // ⊕(ruleId)   Corpus→Claim
  | { op: "synthesize"; subject: string; key: string; rule: string; params?: JsonValue; src: ExprNode } // Corpus→Claim
  | { op: "resolve";    policy: string; rule?: string; src: ExprNode }           // resolution  Corpus→Corpus (policy = registry name)
  | { op: "aggregate";  fn: string; reweight?: string; where?: Predicate; groupBy?: string; src: ExprNode }; // α-family
```

Notes on accuracy (verified against current signatures):

- `Predicate` (used by `sigma` and `aggregate.where`) is reused verbatim from
  `src/algebra/predicate.ts` — already a serializable ADT.
- `DecayPolicy` (used by `delta`) is reused from `src/catalog/corpus.ts` — config data.
- `τ` operators (`tauValid`/`tauRecorded`/`tauKnown`) take a single `Instant` `t`; `mode:"now"`
  takes no `t` and reads `ctx.evaluationClock` instead (clock-pinned at replay).
- `ρ` (`rho(name, query)`) takes a similarity-fn **name** plus a **query `Value`** — both
  serializable data; there is no threshold parameter.
- `κ` (`kappa(fmt, maxTokens, dedupThreshold)`) uses the built-in `defaultCounter` internally,
  so no token-counter reference is needed in the AST.
- `combine` / `synthesize` use an existing distribution **`ruleId` string** (`RULE.*`),
  resolved by the existing `combineGroup` / `bindingFor` machinery — no new registry.
- `Value`, `Format`, `Instant`, `Field` (`= keyof Claim`), and `JsonValue` are existing or
  plain JSON-serializable types.
- **The pipeline is loosely typed** (matching the current `Stage<any,any>[]` reality): the AST
  does not statically enforce inter-stage type compatibility. An ill-typed chain (e.g. `κ` over
  a `Corpus`) throws at evaluate time, which the replay path maps to `failed`.
- Registry names (resolution policy, reweight fn) are validated **at compile time**; an unknown
  name throws `MissingRule`.

## 5. Registries (`registries.ts`)

Only the operator families whose functions are currently **bare consts** (no name lookup)
need new registries. Small `Record<string, Fn>` lookups with a typed accessor that throws
on unknown name, mirroring `similarityFn`:

- `resolutionRegistry(name)` → resolution policy (`resolveDeprecateLower`, `resolveKeepBoth`, `resolveFlagForReview`, `resolveDeprecateMinority`, `resolvePromoteConsensus`, `resolveSynthesizeBelief`)
- `reweightRegistry(name)` → reweight fn (`reweightMultiply`, `reweightMultiplyMean`, `reweightWilsonFloor`, `reweightNormalize`, `reweightBoost`)

Reused as-is (already name/string-keyed, no new registry):

- `similarityFn(name)` — for `ρ`.
- `combineGroup(ruleId, …)` / `bindingFor(distribution)` — for `combine` / `synthesize`
  (the `ruleId` string IS the serializable reference).
- `κ` resolves no rule — it uses the built-in `defaultCounter`.

Every shipped resolution/reweight function is registered. `MissingRule` is a single shared
error type so the replay path can catch it and map to `unavailable_models`.

## 6. Compiler (`compile.ts`)

`compile(node: ExprNode): Stage[]` walks the `src` chain to a flat, ordered stage list
(leaf first), mapping each node to its existing operator closure:

```ts
compile({op:"sigma", pred, src})          → [...compile(src), liftOp(sigma(pred))]
compile({op:"gamma", depth, src})         → [...compile(src), gammaStage(depth)]
compile({op:"rho", fn, query, src})       → [...compile(src), liftOp(rho(fn, query))]
compile({op:"resolve", policy, rule, src})→ [...compile(src), liftOp(resolutionRegistry(policy)(/*…*/, rule))]
```

- Pure structural transform — **no `EvalContext` at compile time**. The context (adapter,
  catalog, pinned clock, version accumulators) is threaded later by the unchanged
  `evaluate()`.
- Registry lookups throw `MissingRule` on unknown name.
- `δ` (decay) and `τ_now` read `ctx.evaluationClock`, so they are naturally clock-pinned at
  replay with zero extra work.

## 7. `deriveClaimFrom` rewiring (`derive.ts`)

Signature changes from `Stage[]` → `ExprNode` (only tests call it today, so this is a clean
change):

```ts
deriveClaimFrom(adapter, catalog, expr: ExprNode, opts): CandidateClaim
```

Internally: `const pipeline = compile(expr); const result = evaluate(pipeline, ctx)` — the
downstream representative/inputs/version-capture logic is unchanged. The substantive change
is provenance population:

```ts
queryExpression: serializeExpr(expr),       // was ""
corpusState:     adapter.maxRecordedSeq(),  // was 0 — the adapter's monotonic logical clock
```

`commitDerived`'s existing guard (rejects similarity-using queries with empty
`similarityVersions`) stays. We add a guard that `queryExpression` is non-empty for any new
derived write.

## 8. Replay re-execution (`replay.ts`)

Extend `replayStatus`. The existing degraded-path checks stay **first and unchanged**; the
re-execution path replaces the current `"failed"` placeholder:

```
1. no derivedFrom / no evaluationClock   → integrity_unknown   (unchanged)
2. any input claim missing               → missing_inputs      (unchanged)
3. similarity version mismatch           → unavailable_models  (unchanged)
4. queryExpression === ""                → integrity_unknown   (v0.1-era, no AST recorded)
5. parseExpr → compile → evaluate(pinned clock, current adapter):
     • MissingRule thrown                → unavailable_models  (+ missingDependencies)
     • other throw                       → failed
     • result == recorded (ε-tolerant)   → exact     (result = recomputed claim)
     • result != recorded                → mismatch  (result = recomputed claim)   ← NEW
```

### 8.1 Epsilon-tolerant comparison

`claimsEquivalent(a, b, ε = 1e-9)` compares the **semantic payload only**:

- `value` — deep-equal; numeric leaves within ε.
- `confidence` Beta — `α` and `β` within ε.

It ignores ids, timestamps, recorded-at, and provenance. Implemented as a small local
helper in `replay.ts`.

### 8.2 `ReplayStatus` extension

```ts
type ReplayStatus =
  | "exact"
  | "mismatch"           // NEW: ran fine, result differs from recorded
  | "unavailable_models"
  | "missing_inputs"
  | "integrity_unknown"
  | "failed";            // execution itself could not proceed
```

`mismatch` is additive; recorded here and flagged for a §7.6 spec footnote.

## 9. Testing strategy (TDD, per-module)

| Module | Key tests |
|--------|-----------|
| `serialize.test.ts` | `parseExpr(serializeExpr(n))` round-trips for every node variant; canonical output is stable across key order |
| `compile.test.ts` | each node compiles to the expected stage list; unknown registry name throws `MissingRule`; nested tree flattens leaf-first |
| `registries.test.ts` | every shipped rule/reweight/resolution/counter is registered and resolvable; unknown name throws `MissingRule` |
| `derive.test.ts` (update) | records non-empty `queryExpression` + `corpusState`; existing assertions adapted to `ExprNode` input |
| `replay.test.ts` (extend) | **exact** (derive → replay round-trips to `exact`); **mismatch** (perturb a contributing claim post-derive → `mismatch` with recomputed result); unknown rule → `unavailable_models`; all pre-existing degraded-path tests preserved |

**End-to-end golden test:** build a Corpus-terminal `ExprNode` exercising
σ→δ→`resolve(synthesizeBelief)` (the resolution-synthesis path appends the derived claim
last, satisfying `deriveClaimFrom`'s "last claim is the representative" contract), derive a
claim, replay → `exact`; then perturb a contributing claim's value and replay the original
→ `mismatch`.

**Terminal-type constraint.** `deriveClaimFrom` reads `result.claims[last]`, so a *derive*
pipeline MUST terminate in a `Corpus` (valid terminals: `sigma`, `tau`, `delta`, `pi`,
`resolve`). The `combine` / `synthesize` (→`Claim`), `rho`/`gamma` (→`RankedCorpus`), and
`kappa` (→`ComposedContext`) nodes are part of the full AST for serialization completeness
and non-derive consumers, but are not valid derive terminals. `compile` itself does not
enforce this (loosely typed); a non-Corpus terminal surfaces as a derive-time error.

## 10. Scope notes / non-goals

- **Embedding-version checking** stays deferred (no embedding models / embedding registry
  exist yet). The existing comment in `replay.ts` anticipates this; `MissingDependency.kind`
  gains no embedding variant in this slice.
- **No query optimizer / reordering** — compile preserves authored order, matching
  `evaluate`'s "no optimizer in the MVP" note.
- **Corpus-state retention** (§7.6's "preserve corpus state long enough for verification")
  is a policy concern, out of scope here. We record the logical timestamp but do not add
  retention enforcement.
- **The other deferred v1 slice** (§5.6 observation-level dedup before evidence pooling) is
  independent and not addressed here.

## 11. Spec deltas to record

- §7.6 `ReplayStatus`: add `mismatch`.
- §2.7 / §7.6: `queryExpression` is now populated for all new derived writes (was always
  `""`); `corpusState` is now a real logical timestamp (was `0`).
