# Carry enforced corpus identity on the `Claim` type

**Date:** 2026-05-31
**Status:** Approved (design)
**Follow-up to:** PRs #13 / #14 (corpus-isolation + tamper-evidence)

## Problem

Mneme isolates tenants by `corpus_id` — the **enforced** boundary, force-stamped on
writes and force-injected on reads by the scoped adapter (`scoped()` in
`src/adapters/sqlite.ts`, `scopedFor()` in `src/mneme.ts`). A separate,
caller-supplied field `workspace` lives on every `Claim`. By default
`workspace === corpusId`, but they can be decoupled (e.g. `openSession({ workspace })`
pins one workspace across many corpora), and that decoupling is reachable from the
public API — so any corpus-scoped decision keyed off `workspace` is a latent
cross-corpus leak.

Six such bugs were found and fixed (read leak, scoped `deleteClaim`, `derive`,
idempotency scope, `replay`, contradiction detection). They share **one generative
cause**: the `Claim` *type* carries `workspace` but **not** `corpus_id`. The
`corpus_id` storage column exists, but `fromRow()` drops it — so any code holding only
a `Claim` structurally cannot reach the enforced boundary and falls back to
`workspace`.

## Goal

Carry the enforced corpus identity on `Claim` so isolation-sensitive code can read a
claim's corpus directly and the structural temptation to use `workspace` disappears —
**without ever reintroducing a `workspace` fallback for an isolation decision.**

## Decision: `corpusId` is OPTIONAL, populated-on-read from the enforced column only

`Claim` gains `corpusId?: CorpusId`. It is populated **only** from the enforced
`corpus_id` storage column (or the in-process enforced corpus a writer already holds).
It is **never** derived from `workspace`.

### Why optional, not required

- **`fromRow` null is decisive.** The `corpus_id` column is nullable: base (unscoped)
  adapter inserts leave it null. A *required* `corpusId` would force `fromRow` to
  invent a value for those rows, and the only available value is `workspace` — exactly
  the conflation this effort exists to kill, relocated into `fromRow`. Optional lets
  `fromRow` honestly leave the field absent.
- **Honesty.** A pre-persist or base-adapter claim genuinely has no enforced corpus
  yet. A required field would be a lie for those claims.
- **Churn for no safety gain.** Required would force `corpusId` onto every full-`Claim`
  test fixture (~30+ files). The isolation safety comes from the scoped adapter, not
  the type, so that churn buys nothing.

### Why the `?? workspace` trap does not bite

The new risk of an optional field is the tempting `claim.corpusId ?? claim.workspace`.
It does not bite because:
- The existing audit rule forbids a `workspace` fallback for any isolation decision.
- The consumers that make isolation decisions already take an **explicit `corpusId`
  param** and keep it (see "Consumers" below) — they never reach for the claim field
  with a fallback.

### Critical safety invariant (preserved)

`corpusId` on the type is a **read-derived** field. It **never** feeds back into a
write's stored `corpus_id`: both `insertClaim` paths persist corpus from the *scope*
(`toRow(c, scope.corpus)` / `toRow(c, null)`), ignoring `c.corpusId`. So carrying the
field cannot corrupt the stored boundary.

## Changes

### 1. `src/core/claim.ts` — the type

- Import `CorpusId` from `./ids.js`.
- Add `corpusId?: CorpusId;` to the `Claim` interface.
- Add `corpusId` to `CandidateClaim`'s `Omit<...>` set. Rationale: `corpus_id` is an
  enforced-write property (force-stamped by the scoped adapter), in the same class as
  `id`/`recorded`/`recordedSeq`/`status`. Candidates are caller-supplied pre-write
  input and must **not** carry it. This also means **zero churn** on the many
  candidate-building sites and candidate fixtures.

### 2. `src/adapters/sqlite.ts` — `fromRow` (answer to design Q2)

Populate `corpusId` only when the column is non-null:

```ts
...(row.corpus_id != null ? { corpusId: asCorpusId(row.corpus_id) } : {}),
```

Null `corpus_id` (base-adapter rows) → field absent. **No `workspace` fallback.**
Import `asCorpusId` from `../core/ids.js`.

### 3. `src/write/pipeline.ts` — `Promoter` stamps the in-process enforced corpus

So persisted-state claims are faithful in-process (not only after a store round-trip),
stamp `corpusId` on the full claims the Promoter builds, guarded on a non-empty
`this.corpusId` (the default Promoter ctor uses `""`):

- `commit`: on `candidateForEnforce` (this also makes the `findValidatedConflict`
  assertion below meaningful — the candidate carries the corpus it is enforced under).
- `supersede`: on `newClaim`.
- `contradictionArtifact`: copy from the `accepted` claim's `corpusId`.
- `promote`: no change — it spreads `...target`, which already carries `corpusId`
  from `getClaim`/`fromRow`.

Use `this.corpusId ? asCorpusId(this.corpusId) : undefined` (omit when empty).

### 4. Consumers keep explicit param + gain a defensive agreement assertion (answer to Q3)

The already-fixed consumers keep their explicit `corpusId` contract — the explicit
caller-named corpus is the safer contract and must not silently regress to reading the
claim. We *add* assertions so a decoupling bug fails loudly:

- `src/write/contradiction.ts` `findValidatedConflict(candidate, adapter, corpusId)`:
  assert `candidate.corpusId === undefined || candidate.corpusId === corpusId`; throw
  on mismatch. Query still keys off the explicit `corpusId`.
- `src/mneme.ts` `replay(corpusId, claim)`: assert
  `claim.corpusId === undefined || claim.corpusId === corpusId`; throw on mismatch.
  Enforcement still flows through `scopedFor(corpusId)`; the assertion catches a caller
  replaying a claim from corpus A under corpus B.

Both use a plain `throw new Error(...)` (the house convention — custom error classes are
reserved for structured domain errors like `MissingRule`), phrased to match the
`unknown corpus "${id}"` style in `catalog.ts`:

```ts
throw new Error(`corpus mismatch: claim.corpusId "${claim.corpusId}" !== enforced corpusId "${corpusId}"`);
```

### 5. Migration / schema (answer to Q4)

**None.** The `corpus_id` column, its backfill, and indexes already shipped in #14.
This change is purely a type addition + `fromRow` read. On-disk format and
schema-version are untouched.

## Explicitly out of scope (deliberately deferred)

`src/algebra/synthesis.ts` and `src/algebra/resolution.ts` build transient in-memory
query/aggregation artifacts. They are never the source of a persisted `corpus_id`
(derived writes go through the Promoter, which force-stamps via the scope), so adding
`corpusId` there is faithfulness gold-plating, not isolation safety. Left absent on
those claims to minimize churn.

## Testing (TDD)

- **`fromRow`:** a scoped read carries `corpusId === <corpus>`; a base-adapter read
  leaves `corpusId` absent (and never equal to `workspace` when they would differ).
- **Promoter:** a committed-then-read claim carries `corpusId`; the in-process built
  claim carries it before round-trip.
- **`findValidatedConflict`:** mismatched `candidate.corpusId` vs `corpusId` throws;
  matching/absent passes.
- **`replay`:** mismatched `claim.corpusId` vs `corpusId` throws; matching/absent runs
  normally.
- **Regression sweep:** `fromRow` now adds a field to read results. Any test doing a
  whole-`Claim` `toEqual`/`toStrictEqual` against a hand-built claim must be updated to
  add `corpusId` or assert specific fields. (Spot check shows assertions are mostly
  field-level, so breakage is expected to be small.)

## Interconnectivity audit outcomes (2026-05-31)

A targeted pattern/SoC/DRY audit (parallel read-only scan) confirmed:
- **SoC/DRY clean:** `toRow(c, corpusId)` takes corpus as a separate arg and never reads
  `c.corpusId`, so the field is read-derived and cannot become a divergent source of
  truth. No pre-persist consumer reads `claim.corpusId` today, so Promoter-stamping is
  side-effect-free faithfulness.
- **Branding (decided):** `corpusId?: CorpusId` is branded, consistent with `Claim`'s
  sibling id fields and `fromRow`'s existing brand-at-boundary casts. The adapter/transport
  layer staying unbranded `string` is a pre-existing condition; branding it is a separate
  refactor, out of scope here.
- **Idioms adopted:** spread-conditional populate in `fromRow` (matches `conf_effective`
  in the same function); plain `throw new Error("corpus mismatch: …")` for the assertions.

## Constraints honored

- Standalone, no new dependencies.
- Enforced-boundary pattern preserved; no `workspace` fallback for any isolation
  decision is introduced.
- Full suite (1131) and `npx tsc --noEmit` must stay green.
