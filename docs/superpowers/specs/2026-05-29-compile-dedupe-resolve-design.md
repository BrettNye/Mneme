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

- **`dedupe`** (`⊕_dedupe`, spec §4.9) — implement.
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

## 3. `dedupe` (rename of `combine`) — implement

`⊕_dedupe` is rule-parameterized and `Corpus → Corpus`. The current `combine` node
(`{ op: "combine"; rule; params?; src }`) already carries exactly the right fields; it is
renamed to `dedupe` for spec fidelity.

- **AST (`ast.ts`):** rename the variant and constructor `combine` → `dedupe`:
  `{ op: "dedupe"; rule: string; params?: Value; src: ExprNode }`, constructor
  `dedupe(rule, src, params?)`.
- **compile (`compile.ts`):** `case "dedupe": return [...compile(node.src), liftOp(oplusDedupe(node.rule, node.params))];`
- **serialize (`serialize.ts`):** replace `"combine"` with `"dedupe"` in `KNOWN_OPS` and
  `REQUIRED_FIELDS` (`["rule", "src"]`).
- **index (`index.ts`):** rename the exported constructor `combine` → `dedupe`. (Breaking
  change to an unused export — no consumers exist.)

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
| `src/algebra/ast.ts` | rename `combine`→`dedupe`; add `threshold` to `resolve` (+ `DEFAULT_RESOLVE_THRESHOLD`). |
| `src/algebra/registries.ts` | `resolutionRegistry` returns `{ fn, input }`; declare input-kind for all six policies. |
| `src/algebra/compile.ts` | add `dedupe` + `resolve` arms; `aggregate` documented throw; keep `never` guard. |
| `src/algebra/serialize.ts` | `KNOWN_OPS`/`REQUIRED_FIELDS`: `combine`→`dedupe`, add `resolve.threshold`. |
| `src/index.ts` | rename exported `combine`→`dedupe`. |
| test files for each of the above. |

## 7. Testing

- `registries.test.ts`: `resolutionRegistry` returns `{ fn, input }` with the correct `input`
  for each of the six policies; unknown name still throws `MissingRule`.
- `compile.test.ts`: `dedupe` compiles to `liftOp(oplusDedupe(...))` and evaluates equal to a
  hand-built dedupe pipeline; each `resolve` policy compiles, uses `pairsOf` vs `clustersOf` per
  its kind, threads `threshold`, and evaluates equal to the hand-built resolution; `aggregate`
  throws `UnsupportedExprOp`; `combine` op no longer exists (the union has no `combine`).
- `serialize.test.ts`: `dedupe` and `resolve` (with `threshold`) round-trip; `aggregate` still
  round-trips; an old `{op:"combine"}` string now fails `parseExpr` (unknown op).
- `mneme.test.ts` (stretch, only if the empirical audit confirms it): derive a claim via a
  `resolve(synthesizeBelief)` query and replay it to `exact`.
- `index.test.ts`: `dedupe` is exported as a value; `combine` is not.

Real in-memory adapter, no mocks. Full suite green; `tsc --noEmit` clean.

**Pre-implementation audit.** Before writing the implementation plan, empirically verify
against the real library: (a) a compiled `dedupe` pipeline evaluates equal to
`oplusDedupe(rule)`; (b) each compiled `resolve` policy evaluates equal to the hand-built
`fn(pairsOf|clustersOf(corpus, threshold))(corpus)`; (c) whether a `resolve(synthesizeBelief)`
derive→replay yields `exact` (to decide if the stretch test is included). Adjust the spec if
any assumption fails.

## 8. Acceptance criteria

- `compile` handles `dedupe` (→ `oplusDedupe`) and all six `resolve` policies (correct
  `pairs`/`clusters` input, `threshold` threaded), evaluating identically to hand-built
  pipelines.
- `aggregate` throws a documented `UnsupportedExprOp`; serialization of `aggregate` still
  round-trips.
- The `resolve` node records `threshold` (always serialized); `dedupe` replaces `combine`
  across ast/serialize/compile/index.
- `resolutionRegistry` exposes per-policy input-kind metadata.
- Full suite green; `tsc --noEmit` clean.

## 9. Out of scope / follow-ups

- Executing `aggregate` (would need per-fn params + a serializable `groupBy` core) — deferred;
  it has no replay value.
- §5.6 observation-level dedup before evidence pooling — the *other* tracked follow-up, a
  separate slice (note: distinct from `⊕_dedupe`, which dedups by `(subject,key,scope)`, not by
  `observation_id`).
