# Mneme v1 — Derived Writes, Provenance & evaluationClock (sub-milestone 3)

**Date:** 2026-05-26
**Status:** Approved (brainstorming)
**Canonical spec:** `mneme-spec-v0.2-consolidated.md` — §7.6 (derived writes, `commit_derived`, replay status), §2.7 (`DerivationProvenance`), §2.4/§0.3 (effective confidence computed at query time).

## Context

Third of four v1 sub-milestones. Combination rules `⊕` and read-time `⊥`/resolve both shipped (green, 400 tests). The algebra already produces derived claims *unpersisted* (`⊕_synthesizeAs`, `resolve_synthesize_belief`). The MVP banked the `DerivationProvenance` type (`src/core/provenance.ts`: `queryExpression`, `corpusState`, `combinationRule?`, `inputClaims`, `similarityVersions`, `embeddingModelVersions`, `evaluationClock`) and the immediate-promote `Promoter` (`src/write/pipeline.ts`).

This slice **persists** derived claims with full provenance, **pins `evaluationClock`** so time-dependent operators (δ decay, `τ_now`) are deterministic, **records** similarity/embedding versions (the irreversible-at-write-time mandate of §7.6), and reports replay **status** from recorded metadata. It is the substrate the bio cognitive layer's Wave 2 (consolidation/dreaming = derived writes) gates on.

**Goal:** `derive_claim_from` + `commit_derived` + `evaluationClock` pinning + degraded-status replay, core `[C]` tier, `requiredTiers = {core}`.

## Scope

**In scope:**
- Persist a derived `CandidateClaim` with a fully-populated `DerivationProvenance` via the existing `Promoter` (so contradiction policy + idempotency still apply).
- Pin a single `evaluationClock` per query so δ/`τ_now` are deterministic (replaces the MVP's build-time `Date.now()` capture).
- Record `similarityVersions` (and `embeddingModelVersions`, always `{}` in v1) — auto-captured during evaluation.
- Enforce mandatory version provenance (§7.6 MUST): a derivation that used similarity ops but lacks `similarityVersions` is rejected.
- Replay reports the four **degraded** statuses from recorded metadata.

**Deferred (NOT this slice):**
- The `exact` replay re-execution engine — requires a serializable + executable query-expression AST (the v1 algebra is JS closures; `queryExpression` is recorded as a loose string). Its own later slice.
- Corpus-state *snapshot* retention — this slice uses the Promoter's monotonic `recordedSeq` as the logical `corpusState` timestamp; full snapshot/retention policy is deferred.
- Embedding models — none exist in v1 (no `ρ_cosine`/embeddings), so `embeddingModelVersions` is always `{}`.

## Architecture note — cross-cutting clock/version threading

Deterministic `evaluationClock` and auto-captured similarity versions require touching three already-shipped files. This is the unavoidable core of "deterministic, version-recorded derivations":

- **`EvalContext`** (`src/algebra/expression.ts`) gains `evaluationClock: Instant` plus mutable `usedSimilarityVersions: Record<string,string>` and `usedEmbeddingModelVersions: Record<string,string>` accumulators.
- **`SimilarityFn`** (`src/algebra/similarity.ts`) gains a `version: string` field (`simJaccard` → e.g. `"jaccard@1"`, `simExact` → `"exact@1"`).
- **Façade builders** (`src/mneme.ts`): `query()` pins one `evaluationClock` (default `Date.now()`, caller-overridable) into the ctx and initializes the accumulators; `delta.*` and `tau.now()` read `ctx.evaluationClock` (ctx-aware stages, no longer `liftOp` of a build-time clock); `rho.*` records its fn's `version` into `ctx.usedSimilarityVersions` when it runs.

These are contract changes to done files; the DAG-planning step will grep for consumers (EvalContext shape, the δ/τ/ρ builder tests) so the cascade is owned, not discovered mid-flight.

## Components

1. **EvalContext extension** (`src/algebra/expression.ts`) — add `evaluationClock` + the two version accumulators to `EvalContext`; `leaf`/`evaluate`/`pipe`/`liftOp`/`gammaStage` otherwise unchanged.
2. **SimilarityFn version** (`src/algebra/similarity.ts`) — add `version` to the `SimilarityFn` interface and the two bindings; `similarityFn(name)` unchanged.
3. **Façade clock/version wiring** (`src/mneme.ts`) — `query(corpusId, pipeline, opts?)` pins `evaluationClock = opts?.evaluationClock ?? Date.now()`; `delta.*`/`tau.now()` become ctx-aware (read `ctx.evaluationClock`); `rho.*` records `version` into the ctx accumulator. Existing query behavior is otherwise preserved.
4. **`derive_claim_from`** (`src/write/derive.ts`) — `deriveClaimFrom(evalCtx, pipeline, { subject, key, scope, combination? }): CandidateClaim`: evaluate the pipeline through a freshly pinned ctx, take the (synthesized) result claim, and assemble a partial `DerivationProvenance` (`inputClaims` = ids of the corpus claims that contributed, `combinationRule` = combination, `evaluationClock` = ctx's pinned clock, `similarityVersions`/`embeddingModelVersions` = ctx accumulators). Returns a `CandidateClaim` with `provenance.derivedFrom` partially set.
5. **`commit_derived`** (`src/write/derived-write.ts`) — `commitDerived(promoter, candidate, { queryExpression, corpusState, policy?, writer })`: finalize `provenance.derivedFrom` (set `queryExpression` serialized string + `corpusState` seq), **enforce mandatory version provenance** (§7.6 MUST), then route to `Promoter.commit` (contradiction policy + idempotency apply). Enforcement mechanism: scan the serialized `queryExpression` for similarity-operator markers (`rho`/`jaccard`/`exact`/`cosine`); if a marker is present and `similarityVersions` is empty, reject with a typed error. (When the candidate came through `derive_claim_from`, auto-capture guarantees `similarityVersions` is populated whenever `ρ` ran, so this check only bites callers who bypass `derive_claim_from`.) Returns the commit result.
6. **Replay status** (`src/write/replay.ts`) — `ReplayResult { status: ReplayStatus; result?: Claim; missingDependencies: MissingDependency[] }`; `ReplayStatus = "exact" | "unavailable_models" | "missing_inputs" | "integrity_unknown" | "failed"`. `replayStatus(claim, adapter, catalog): ReplayResult` inspects the recorded `DerivationProvenance` and reports: `integrity_unknown` if the claim has no `derivedFrom`/version fields (pre-v1); `missing_inputs` if any recorded `inputClaims` id is absent from the adapter; `unavailable_models` if a recorded `similarityVersions` entry is not resolvable in the similarity registry; else `failed` (cannot proceed) — `exact` is never returned this slice (re-execution deferred), and that limitation is documented in the function.

## Data flow

```
deriveClaimFrom(ctx, pipeline, {subject, key, scope, combination})
  → evaluate(pipeline, ctxWithPinnedClock)   // δ/τ_now use ctx.evaluationClock; ρ records versions
  → synthesized Claim (via ⊕/resolve, already shipped)
  → CandidateClaim { ...result, provenance.derivedFrom = {inputClaims, combinationRule, evaluationClock, similarityVersions, embeddingModelVersions} }

commitDerived(promoter, candidate, {queryExpression, corpusState, policy, writer})
  → finalize derivedFrom (queryExpression string + corpusState seq)
  → enforce mandatory versions (reject if similarity used but versions empty)
  → promoter.commit(candidate, {policy, writer})   // insert + contradiction + idempotency
  → CommitResult
```

## Testing (pinned to §7.6/§2.7)

- **evaluationClock determinism:** two `query()` runs with the same pinned `evaluationClock` produce identical δ-decayed effective confidences and identical `τ_now` slices (no wall-clock drift between calls).
- **commit_derived provenance:** a committed derived claim's `provenance.derivedFrom` carries `inputClaims` (the contributing ids), `combinationRule`, `evaluationClock`, `queryExpression`, `corpusState`, and `similarityVersions`.
- **Mandatory-version enforcement:** `commit_derived` with a `queryExpression` containing a similarity marker (e.g. `"...rho.jaccard..."`) and empty `similarityVersions` is rejected with a typed error; the same with versions present commits; a `queryExpression` with no similarity marker and empty `similarityVersions` commits fine.
- **derive captures versions:** running a pipeline containing `rho.jaccard(...)` populates `ctx.usedSimilarityVersions` with the jaccard fn version; a pipeline with no similarity op leaves it empty.
- **replayStatus:** `integrity_unknown` for a claim with no `derivedFrom`; `missing_inputs` when a recorded input id is absent from the adapter; `unavailable_models` when a recorded similarity version is not in the registry.
- **Promoter integration:** a derived commit honors the contradiction policy (e.g. `reject_on_contradiction`) and idempotency window.

## Stack & conventions

TypeScript (ESM/NodeNext, strict), Vitest, Zod, better-sqlite3 — unchanged. Core `[C]` tier only. TDD mandatory; each component pinned to the behaviors above. Relative imports use explicit `.js` extensions; concurrent implementers commit with pathspec. Contract-changing tasks (EvalContext, SimilarityFn) must grep for consumers during planning.
