---
title: Compile coverage — dedupe (⊕_dedupe) + resolve (⊥)
created: 2026-05-29
status: design
---

# Compile coverage: `dedupe` + `resolve` — Design

## 1. Goal

Make the replay engine's `compile` (`src/algebra/compile.ts`) cover the algebra operators it
currently rejects with `UnsupportedExprOp`. Today `combine`, `resolve`, and `aggregate` all
throw. This slice implements the two that are genuine, pipeline-fitting spec operators and
formalizes the third as an intentional boundary:

- **`combine`** (implemented as `⊕_dedupe`, spec §4.9) — implement (compile-only).
- **`resolve`** (`⊥` resolution, spec §4.8) — implement.
- **`aggregate`** (`α`, spec §4.13) — keep serializable; `compile` throws a documented error.

## 2. Spec grounding (audited)

- **§4.9 Belief combination — ⊕.** Defines two operators: `⊕_dedupe : Corpus → Corpus`
  (combine claims sharing `(subject, key, scope)` via a combination rule) and
  `⊕_synthesize_as : Corpus → Claim`. The AST's `synthesize` node already covers
  `synthesize_as`. `⊕_dedupe` is implemented as `oplusDedupe(ruleId, params?)(corpus): Corpus`
  (exported from `src/algebra/combination.ts`) — `Corpus → Corpus`, so it fits the linear
  pipeline with no AST enrichment. The current `combine` node is an ill-named orphan that
  should *be* `⊕_dedupe`.
- **§4.8 Contradiction detection / resolution — ⊥.** Resolution policies operate on
  contradiction `pairs` (`pairsOf(corpus, threshold)`) or `clusters`
  (`clustersOf(corpus, threshold)`) and return `Corpus → Corpus`.
- **§4.13 Aggregation — α.** `AggregateResult` is explicitly "a second terminal type alongside
  `Corpus` and `ComposedContext`." Replay (§7.6) verifies a derived *Claim*; aggregate never
  produces a claim, so no derived claim ever carries an aggregate query — leaving `aggregate`
  non-compilable-for-replay is spec-consistent.

## 3. `combine` — implement as `⊕_dedupe` (no rename)

`⊕_dedupe` is rule-parameterized and `Corpus → Corpus`. The existing `combine` node
(`{ op: "combine"; rule; params?; src }`) already carries exactly the right fields and maps
directly to `oplusDedupe(ruleId, params?)`. **We keep the op named `combine`** and document
`combine ≡ ⊕_dedupe`.

Rationale for *not* renaming to `dedupe`: a rename would cascade across `ast.ts`, `compile.ts`,
`serialize.ts`, and `index.ts` simultaneously (the op-string is referenced in all four), which
breaks per-task-green commits and file-disjoint parallelism, and is a breaking change to the
public `combine` export — all for a purely cosmetic spec-name match. Keeping the name makes
this a **single-line `compile.ts` change** with no `ast`/`serialize`/`index` churn.

- **compile (`compile.ts`):** `case "combine": return [...compile(node.src), liftOp(oplusDedupe(node.rule, node.params))];`
- **ast (`ast.ts`):** unchanged for combine — add a doc comment noting `combine ≡ ⊕_dedupe`.
- **serialize (`serialize.ts`):** unchanged for combine (already in `KNOWN_OPS`/`REQUIRED_FIELDS`).
- **index (`index.ts`):** unchanged — `combine` stays exported.

`oplusDedupe` rejects deprecated rules internally (`assertNotDeprecatedRule`), so a bad rule
throws at evaluate time → mapped to `failed` by replay (unchanged behavior).

## 4. `resolve` (⊥) — implement

The six resolution policies split by the input they consume; all need a `threshold` to derive
that input, and all return `Corpus → Corpus`:

| policy | input | extra |
|--------|-------|-------|
| `resolveDeprecateLower` | `pairs` | — |
| `resolveKeepBoth` | `pairs` | — |
| `resolveFlagForReview` | `pairs` | — |
| `resolveDeprecateMinority` | `clusters` | — |
| `resolvePromoteConsensus` | `clusters` | — |
| `resolveSynthesizeBelief` | `clusters` | optional `rule` |

- **AST (`ast.ts`):** add `threshold: number` to the `resolve` node; the `resolve(...)`
  constructor defaults it (`DEFAULT_RESOLVE_THRESHOLD = 0.5`) so the threshold is **always
  recorded** in the serialized query (replay determinism). Keep optional `rule`.
  New shape: `{ op: "resolve"; policy: string; threshold: number; rule?: string; src: ExprNode }`.
- **Registry (`registries.ts`):** `resolutionRegistry(name)` returns
  `{ fn, input: "pairs" | "clusters" }` instead of the bare function. (No current consumers, so
  the return-shape change is free.) Each of the six entries declares its `input`.
- **compile (`compile.ts`):**
  ```ts
  case "resolve": {
    const { fn, input } = resolutionRegistry(node.policy); // throws MissingRule on unknown
    return [...compile(node.src), (c: Corpus) => {
      const groups = input === "pairs" ? pairsOf(c, node.threshold) : clustersOf(c, node.threshold);
      return (fn as (g: unknown, rule?: string) => (c: Corpus) => Corpus)(groups, node.rule)(c);
    }];
  }
  ```
  `node.rule` is harmlessly ignored by the five non-synthesize policies and defaulted by
  `resolveSynthesizeBelief`. `pairsOf` / `clustersOf` come from `src/algebra/contradiction.ts`.
- **serialize (`serialize.ts`):** `REQUIRED_FIELDS["resolve"]` becomes `["policy", "threshold", "src"]`.

## 5. `aggregate` (α) — documented boundary

Keep the `aggregate` node, its constructor, and full serialization (it round-trips). `compile`
throws a **clear, intentional** error stating aggregate is a read-time terminal
(`AggregateResult`, §4.13), not a replayable claim-derivation operator:

```ts
case "aggregate":
  throw new UnsupportedExprOp("aggregate"); // read-time terminal (AggregateResult), not a replayable claim query — §4.13
```

(Exhaustiveness `default: never` guard stays.)

## 6. Files

| File | Change |
|------|--------|
| `src/algebra/ast.ts` | add `threshold: number` to the `resolve` node (+ `DEFAULT_RESOLVE_THRESHOLD`); doc comment `combine ≡ ⊕_dedupe`. (No combine rename.) |
| `src/algebra/registries.ts` | `resolutionRegistry` returns `{ fn, input }`; declare input-kind for all six policies. |
| `src/algebra/compile.ts` | implement `combine` arm (→ `oplusDedupe`) + `resolve` arm; `aggregate` documented throw; keep `never` guard. |
| `src/algebra/serialize.ts` | `REQUIRED_FIELDS["resolve"]` gains `threshold`. (combine unchanged.) |
| test files for each of the above. |

`src/index.ts` is **not** modified (`combine` stays exported).

## 7. Testing

- `registries.test.ts`: `resolutionRegistry` returns `{ fn, input }` with the correct `input`
  for each of the six policies; unknown name still throws `MissingRule`.
- `compile.test.ts`: `combine` compiles to `liftOp(oplusDedupe(...))` and evaluates equal to a
  hand-built dedupe pipeline; each `resolve` policy compiles, uses `pairsOf` vs `clustersOf` per
  its kind, threads `threshold`, and evaluates equal to the hand-built resolution; `aggregate`
  throws `UnsupportedExprOp`.
- `serialize.test.ts`: `resolve` (with `threshold`) round-trips; `combine` and `aggregate` still
  round-trip.
- `mneme.test.ts` (stretch, only if the empirical audit confirms it): derive a claim via a
  `resolve(synthesizeBelief)` query and replay it to `exact`.
Real in-memory adapter, no mocks. Full suite green; `tsc --noEmit` clean.

**Pre-implementation audit.** Before writing the implementation plan, empirically verify
against the real library: (a) a compiled `dedupe` pipeline evaluates equal to
`oplusDedupe(rule)`; (b) each compiled `resolve` policy evaluates equal to the hand-built
`fn(pairsOf|clustersOf(corpus, threshold))(corpus)`; (c) whether a `resolve(synthesizeBelief)`
derive→replay yields `exact` (to decide if the stretch test is included). Adjust the spec if
any assumption fails.

## 8. Acceptance criteria

- `compile` handles `combine` (→ `oplusDedupe`) and all six `resolve` policies (correct
  `pairs`/`clusters` input, `threshold` threaded), evaluating identically to hand-built
  pipelines.
- `aggregate` throws a documented `UnsupportedExprOp`; serialization of `aggregate` still
  round-trips.
- The `resolve` node records `threshold` (always serialized). `combine` keeps its name and is
  documented as `⊕_dedupe`; no rename, no `index.ts` change.
- `resolutionRegistry` exposes per-policy input-kind metadata.
- Full suite green; `tsc --noEmit` clean.

## 9. Out of scope / follow-ups

- Executing `aggregate` (would need per-fn params + a serializable `groupBy` core) — deferred;
  it has no replay value.
- §5.6 observation-level dedup before evidence pooling — the *other* tracked follow-up, a
  separate slice (note: distinct from `⊕_dedupe`, which dedups by `(subject,key,scope)`, not by
  `observation_id`).
