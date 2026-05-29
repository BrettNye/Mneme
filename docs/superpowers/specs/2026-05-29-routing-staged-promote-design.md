# Design — Value-predicate selection, §10.2 capability routing, staged-promote, spec reconciliation

**Date:** 2026-05-29
**Status:** approved (brainstorming)
**Findings addressed:** audit #5 (§10 adapter / §10.2 capability routing) and #9 (§7.1 staged-promote)

## Context and decisions

A deep audit of `src/` against `mneme-spec-v0.2-consolidated.md` flagged #5 (adapter-protocol divergence, `[P]`) and #9 (staged-promote absent, §7.1). Two spec passages reframed both:

- **§7.1 "correctness vs. performance"** — the two-phase pipeline is *a correctness model, not a prescription of physical execution*; implementations MAY pipeline provided observable behavior is preserved. So immediate-promote already conforms and staged-promote is a *supported mode*, not a missing obligation.
- **§10 is `[P]`** — "the protocol is the contract; consumers MAY supply their own." The closure `transaction<T>(fn)` is a legitimate alternative to handle-based `begin/commit/rollback`.

The user confirmed the spec **serves the reference implementation** (the `[P]` latitude is intentional), and chose:

- **Adapter shape:** reconcile the spec to bless the closure-txn idiom; do **not** reshape code to handle-based transactions; do **not** add `ensureIndex`/`dropIndex` (cost-planner territory, deferred to v0.3 per App G).
- **Routing scope: option A — capability layer only.** Reject `unsupported` at parse, warn on large `fallback_in_memory` working sets, make SQLite's matrix honest. Real SQL push-down / plan fusion is deferred to when the Postgres/DuckDB adapters land (the spec positions SQLite as low-volume, §10.3; push-down would optimize the backend the spec says *not* to use for value-predicate-heavy work).
- **Staged-promote:** in-memory staging buffer.
- **Warning channel:** optional `onWarning` callback, `console.warn` fallback.

## 1. Value predicates in the selection language *(prerequisite)*

Today `ValuePredicate` (`src/algebra/value-predicate.ts`) is a standalone module — it is **not** expressible inside a `σ` predicate, so the capability router would have nothing to act on. Wire it in by **flattening** `ValuePredicate` into the `Predicate` union:

- The value-predicate op names are already uniquely prefixed (`valueEq`, `valueGt`, `valueIn`, `valueExists`, `valueRegex`, `valueNull`, `valueMatches`) and disjoint from the base op names (`subjectEq`, `keyEq`, …), so the two discriminated unions compose with a plain union — no `{op:"value"}` carrier / double dispatch:
  ```ts
  // src/algebra/predicate.ts
  export type Predicate =
    | { op: "subjectEq"; value: string }
    | /* …existing base ops… */
    | ValuePredicate;            // imported from ./value-predicate.js
  ```
  (Flatten chosen over a carrier variant: the value ops already have unique names and live in their own module, so a wrapper would add nesting and double dispatch for no benefit; flat is the idiomatic discriminated-union shape the rest of `Predicate` already uses, and is more ergonomic for the consumer — `sigma({op:"valueEq",path,value})` rather than `sigma({op:"value",pred:{…}})`.)
- Add a type guard `isValuePredicate(p: Predicate): p is ValuePredicate` (checks `p.op` against the set of value-predicate ops). `matches(claim, p)` routes value ops through it: `if (isValuePredicate(p)) return matchesValue(claim.value, p);`. The router and `collectValuePredicates` likewise use the guard to find value predicates.
- Add `predicateKindOf(vp: ValuePredicate): PredicateKind` mapping:
  | ValuePredicate op | PredicateKind |
  |---|---|
  | `valueEq` | `equality` |
  | `valueGt` | `range` |
  | `valueIn` | `set_membership` |
  | `valueRegex` | `regex` |
  | `valueMatches` | `structural_pattern` |
  | `valueNull`, `valueExists` | `null_check` |

## 2. §10.2 capability layer (option A)

New module `src/algebra/value-routing.ts`:

- `collectValuePredicates(pred: Predicate): ValuePredicate[]` — walks a predicate tree (descending `and`/`or`/`not`) and returns the value predicates it contains.
- `routeValuePredicates(pred, caps, opts)` — for each value predicate, look up `valuePredicateLevel(caps, predicateKindOf(vp))`:
  - **`unsupported`** → throw `UnsupportedValuePredicateError` naming the path + kind + adapter.
  - **`fallback_in_memory`** and working-set size `> threshold` → emit a `QueryWarning` via `onWarning`.
  - **`native_indexed` / `native_unindexed`** → proceed (no push-down in this pass).

Integration point: a **value-aware selection stage**. The `sigma` builder in `mneme.ts` wraps `sigmaOp(p)` so that, at evaluation entry, it consults `ctx.adapter.capabilities()` and runs `routeValuePredicates` over `p` before filtering. Unsupported → throw immediately; fallback over threshold → warn; then filter in memory as today.

- **`EvalContext`** gains `onWarning?: (w: QueryWarning) => void` and `fallbackWarnThreshold?: number` (default `10_000`).
- **`m.query(corpusId, pipeline, opts)`** `opts` gains `onWarning?` and `fallbackWarnThreshold?`, threaded into the `EvalContext`.
- Default when no `onWarning` is supplied: `console.warn` (costs are never silently swallowed, per §10.2 "MUST be informed").
- `QueryWarning` shape: `{ kind: "fallback_in_memory"; predicateKind: PredicateKind; path?: string; workingSetSize: number; threshold: number; message: string }`.

**Honest limitation (documented):** with the opaque `Stage[]` live-query model, rejection/warning happens at *evaluation entry*, not truly pre-load. True pre-load parse-time rejection requires routing live queries through the AST (`compile.ts`) — deferred with the optimizer work.

**SQLite matrix made honest** (`src/adapters/sqlite.ts`): value-predicate kinds change from `native_unindexed` to `fallback_in_memory`, matching the load-all-then-filter execution. This activates the warn path for SQLite and aligns the declared capability with reality. (A `// JSON1 push-down → native_unindexed is a v0.3 optimization` note records the future.)

## 3. Staged-promote (in-memory buffer)

A per-`createMneme`-instance staging buffer (`Map<string, StagedEntry>`, alongside `promoters`). `StagedEntry = { corpusId: string; candidate: CandidateClaim }`. Methods on `Mneme`:

- `emitCandidate(corpusId, candidate, opts?: { idempotencyKey?: string }) → { stagingId }` — validates the corpus exists, buffers the candidate, returns a generated `stagingId`. **Not persisted; invisible to `query`/`read`/`readByIds`.**
- `promoteStaged(stagingId, opts: { writer; policy?; idempotencyKey? }) → { id, status }` — pulls the entry, runs the existing `promoterFor(corpusId).commit(...)` pipeline (full promotion + contradiction enforcement), removes it from the buffer. Throws if `stagingId` is unknown.
- `promoteAllStaged(corpusId, opts: { writer; policy?; batchPolicy? }) → BatchResult` — promotes every staged candidate for the corpus via the existing `commitBatch` path, clearing them from the buffer.
- `listStaged(corpusId?) → { stagingId: string; corpusId: string }[]` — introspection.
- `discardStaged(stagingId) → boolean` — drop without promoting; returns whether an entry was removed.

`stagingId` is generated with the existing id generator (or a dedicated counter); it is distinct from a committed claim `id`. The buffer is non-durable by design — staged candidates are uncommitted work and are correctly lost if the process restarts before promotion.

## 4. Spec reconciliation (`mneme-spec-v0.2-consolidated.md`)

- **§10** — In the `StorageAdapter` contract, replace `beginTransaction/commit/rollback` with the closure form `transaction<T>(fn: () -> T) -> T`, plus a short rationale note (the closure form makes unbalanced/leaked transactions structurally impossible). Document the richer reference method set the implementation relies on (idempotency store, event log, `maxRecordedSeq`). Mark `ensureIndex`/`dropIndex` as deferred to v0.3 (cost-based planner territory) rather than required protocol methods. `subscribeChanges` stays optional.
- **§10.2** — Change the SQLite row of the capability matrix to `fallback_in_memory` across value-predicate kinds, with a footnote that JSON1 push-down (making it `native_unindexed`) is a v0.3 optimization. Document the `onWarning` delivery and the parse-time-rejection-of-`unsupported` behavior.
- **§7.1** — Note that the reference implementation uses immediate-promote as the default mode and provides staged-promote via an in-memory staging buffer (emit → deferred/batched promote).
- Run `bash spec/verify-spec.sh` after editing; it must stay 39/39.

## Testing

- **predicate.ts** — `op:"value"` carrier matches via `matchesValue`; composes inside `and`/`or`/`not`.
- **value-routing.ts** — `unsupported` kind throws `UnsupportedValuePredicateError`; `fallback_in_memory` over threshold emits a `QueryWarning` through the callback; under threshold and `native_*` stay silent; `collectValuePredicates` finds value predicates nested in compound predicates.
- **sqlite** — capability matrix reports `fallback_in_memory` for value-predicate kinds.
- **staged-promote (façade, through `createMneme` + SQLite)** — emitted candidate is invisible to `query`/`readByIds`; `promoteStaged` commits it and removes it from `listStaged`; `promoteAllStaged` returns a `BatchResult` and clears the buffer; `discardStaged` drops without committing; unknown `stagingId` throws / returns false as specified.
- **routing integration (façade)** — a query whose `σ` carries an `unsupported` value predicate throws; one over a large `fallback_in_memory` set invokes the supplied `onWarning`.

## Explicitly out of scope

- Handle-based transaction reshape; `ensureIndex`/`dropIndex` (per decision — reconciled in the spec instead).
- Real SQL push-down / `ExecutionPlan` value-predicate extension / plan fusion (v0.3, when Postgres/DuckDB adapters exist).
- True pre-load parse-time rejection via the AST path (documented limitation; evaluation-entry rejection is used instead).
- Cost models / optimizer internals (App G, v0.3).
