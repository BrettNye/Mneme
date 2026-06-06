# Similarity slice: embedding adapter, hybrid ranking, relevance abstention (design)

**Date:** 2026-06-05
**Status:** Approved design, pre-implementation
**Canonical spec:** `mneme-spec-v0.2-consolidated.md` (repo root) — §2.7 (derivation provenance / version capture), §3.2 (`similarities`), §3.3 (`defaultSimilarityFn`), §4.6 (`ρ`, `SimilarityFn` `[P]`, `sim_cosine` "requires an embedding adapter"), §7 (replay stratification), Appendix B.
**Driven by:** the post-PR#20 deficiency board — KU recall@3 stuck at 0.75 with per-question receipts showing gold old-session sibling claims ranked 4–9 under lexical `rho.jaccard`; probe 3 (NYC acronym) documented expected-fail; abstention measured 0 for both arms (structural abstention never fires without a relevance bar).

## Problem

Three measured deficiencies share one missing capability — a semantic similarity signal:

1. **Ranking** (the accuracy lever): `rho.jaccard` fills top-3 with the newer session's lexically-closer claims; surviving gold claims sit at ranks 4–9 in all five missing KU questions. recall@10 = 1.0 proves everything needed survives — the residue is pure ranking order.
2. **Acronym/semantic paraphrase**: jaccard("NYC", "New York City") = 0 (disjoint token sets) — probe 3 is this slice's named acceptance case (pinned in the detection-composition spec).
3. **Abstention**: lexical overlap always lets something survive, so `abstained: top.length === 0` never fires. A relevance threshold needs scores meaningful enough to threshold on; jaccard's are too brittle.

## Decisions made during brainstorming (user-ratified)

1. **Scope:** embedding capability + ranking + abstention. **Similarity-tolerant key matching is explicitly deferred** to its own slice (it changes `⊥` grouping semantics — detection correctness, not ranking; probe 4 remains its acceptance case).
2. **Model runtime — injected adapter port.** Core defines the `EmbeddingAdapter` protocol; the local model (transformers.js + bge-small-en-v1.5 quantized) is a devDependency wired by bench (MCP later). Core dependencies unchanged. This is canonical §4.6's own shape (`sim_cosine` "requires an embedding adapter"; `SimilarityFn` is `[P]`) and the bio `DreamFn` injection precedent. Rejected: transformers.js as a core dependency (heavy native dep + runtime model download in a 3-dep library); optional subpath export (packaging surface without a consumer yet — graduates when the MCP slice needs it).
3. **Sync/async seam — warm-up + sync cache.** `evaluate()` and `SimilarityFn.scoreOne` are synchronous; embedding inference is async-only. Embeddings are computed OUTSIDE the query by `await warmEmbeddings(...)` and stored in a cache keyed `(adapter.id@version, canonicalText)`; `sim_cosine.scoreOne` is a synchronous cache lookup. The evaluate/compile/replay substrate is untouched. Rejected: async evaluate (substrate-wide churn); sync inference (not offered by the runtime).
4. **Ranking — similarity-fn combinator, composition-first.** `hybridMax(jaccard, cosine)` registered under a versioned composite name; `rho` is untouched (it already takes a fn name — pure registry composition). `max` is parameter-free and preserves both exact-match and semantic wins. Rejected for now: pure cosine swap (semantic-only ranking can demote exact lexical matches); RRF rank fusion (new machinery + two passes — only if hybrid-max measurably fails; weighted-blend α stays in reserve as a dial).
5. **Abstention — library surface.** `relevanceFloor(minScore)` as an exported read-surface Stage; bench arm A exercises it; the future MCP recall tool inherits it. Rejected: bench-only floor (dogfood wouldn't get abstention).
6. **Acceptance targets:** KU recall@3 ≥ 0.9; abstention ≥ 0.6 (≥3/5) with ZERO false abstentions on answerable categories; updateCorrect 1.0 hard no-regression; probe 3 flips green.
7. **Dedupe keeps jaccard this slice.** Cosine never scores unrelated text at 0, so the dedupe cutoff space doesn't transfer; changing ranking and dedupe simultaneously would confound bench attribution. Dedupe-fn swap = separate measured experiment.

## Audit amendments (2026-06-05, post-scan, user-approved)

Three parallel scanners (repo-pattern/code-reality, bio + cross-layer embedding usage, DRY/SRP/SoC) produced these binding refinements, folded into the Design sections below:

- **B1 (high, SoC): `cosineOver` is throw-only in v1.** The originally-proposed construction-time `fallback`/`onWarning` options violated the repo's per-query warning pattern (warnings thread through `EvalContext.onWarning` at query time — mneme.ts:78-84; a registration-time callback can't be overridden per query) and had no consumer this slice (warm-up guarantees cache hits). Graceful fallback + per-query warning routing (which also requires making `QueryWarning` a discriminated union) is deferred to a future slice with measured demand.
- **B2 (critical): version concerns separated.** `SimilarityFn.version` is math-only (`"cosine@1"`; `"hybrid-max@1[jaccard@1,cosine@1]"`); embedding-model identity lives EXCLUSIVELY in the `embeddingVersions` metadata field and is checked by the new `embedding_version` replay arm. One concern per replay check — model drift never double-reports through the similarity-version check (which compares by exact `===`).
- **B3: `MissingDependency.kind` explicitly gains the `"embedding_version"` member** (src/write/replay.ts:13-20 — the union the deferral comment reserved).
- **B4 (SoC + blast radius): `answerArmA` stays synchronous.** Warm-up is the CALLER's responsibility (run.ts/probes warm from the records they ingested plus the question text — they already hold both); embedding-backed tests warm in setup; jaccard-config tests untouched (~18 sync tests unchanged). I/O (warming) and query logic stay separated.
- **B5: `relevanceFloor` colocates in src/algebra/similarity.ts** (rho lives there and produces RankedCorpus); a `ranked.ts` split waits for a second RankedCorpus operator.
- **B6: registry error semantics pinned.** Lookup error stays the existing plain `Error` with `/no similarity fn/` message (asserted by existing tests; distribution-registry precedent); `registerSimilarity` collision throws a descriptive plain `Error`. `MissingRule` rejected (it means *missing entry*, not collision); a shared `createRegistry<T>` factory rejected as premature until a third dynamic registry exists.
- **B7 (verified): no embedding usage exists anywhere in the repo today** (exhaustive grep: zero matches) — this port is THE single embedding abstraction; see "Single embedding abstraction" section.
- **Clean bills:** rho-builder hardcoding claim exact (mneme.ts:105-120); replay mirror-structure exact; `canonicalizeValue` parity verified; `EmbeddingCache`-as-class matches StagingBuffer/Promoter precedent; `src/algebra/` placement correct per the DreamFn port precedent (`src/adapters/` is persistence-only); warmEmbeddings eager validation = house pattern (oplusDedupe cutoff precedent).

## Design

### 1. Embedding port + cache + warm-up (src/algebra/embedding.ts — NEW)

```ts
export interface EmbeddingAdapter {
  /** Batched; one vector per input text. */
  embed(texts: string[]): Promise<number[][]>;
  /** Model identity, e.g. "bge-small-en-v1.5" — the EmbeddingModelId of canonical §2.7. */
  id: string;
  /** Pinned version (quantization/runtime revision), e.g. "q8@1" — recorded against id in provenance. */
  version: string;
  dim: number;
}

export class EmbeddingCache {
  // Map keyed `${adapter.id}@${adapter.version}␟${canonicalText}` → Float32Array
  get(adapter: { id: string; version: string }, text: string): Float32Array | undefined;
  set(adapter: { id: string; version: string }, text: string, v: Float32Array): void;
}

/** Batched; skips cache hits; validates dim and finiteness at warm-up time (fail BEFORE queries). */
export async function warmEmbeddings(
  adapter: EmbeddingAdapter,
  cache: EmbeddingCache,
  texts: string[],
): Promise<void>;

/**
 * Returns a SimilarityFn scoring cosine over cached embeddings, mapped to [0,1] via (1+cos)/2.
 * version: "cosine@1" (math-only — audit B2); embeddingVersions: { [adapter.id]: adapter.version }.
 * Values canonicalized via the same canonicalizeValue path jaccard uses.
 * Cache miss: ALWAYS throws (message names the missing text hash + "run warmEmbeddings").
 * V1 is throw-only by design (audit B1): warm-up makes misses configuration errors, not
 * runtime conditions; graceful fallback + per-query warning routing is a deferred slice.
 */
export function cosineOver(
  adapter: EmbeddingAdapter,
  cache: EmbeddingCache,
): SimilarityFn;
```

V1 cache is in-memory per-process. Sqlite persistence (an embeddings table keyed model+valueHash) is deferred perf work.

### 2. Registry + hybrid combinator (src/algebra/similarity.ts — MOD)

```ts
/** Dynamic registration. Throws a descriptive plain Error on collision with a DIFFERENT fn;
 *  idempotent re-register of the same object is a no-op (test reruns). Built-ins (jaccard,
 *  exact) remain pre-registered; the lookup error message `/no similarity fn/` is unchanged
 *  (existing tests assert it — audit B6). */
export function registerSimilarity(name: string, fn: SimilarityFn): void;

/** scoreOne = max(a.scoreOne, b.scoreOne); isPure = a.isPure && b.isPure;
 *  version: `hybrid-max@1[${a.version},${b.version}]` — components are math-only versions
 *  (e.g. "hybrid-max@1[jaccard@1,cosine@1]"), machine-generated, compared by exact equality
 *  at replay; embeddingVersions: { ...a.embeddingVersions, ...b.embeddingVersions }. */
export const hybridMax: (a: SimilarityFn, b: SimilarityFn) => SimilarityFn;
```

`rho` is untouched. Consumers register `"cosine"` and `"hybrid"` and pass those names where `"jaccard"` goes today.

### 3. Provenance + replay (src/algebra/similarity.ts or rho call path; src/write/replay.ts — MOD)

- **Transport mechanism (pinned here, not deferred):** `SimilarityFn` gains an optional additive metadata field `embeddingVersions?: Record<string, string>` (EmbeddingModelId → version). `cosineOver` sets it to `{ [adapter.id]: adapter.version }`; `hybridMax` merges both operands'. A new generic surface builder `rho.by(name, query)` (the existing `rho.jaccard`/`rho.exact` builders are hardcoded — mneme.ts:106-120 — so any new fn name needs one) records `ctx.usedSimilarityVersions[name] = fn.version` AND merges `fn.embeddingVersions` into `ctx.usedEmbeddingModelVersions`. Recording happens whenever an embedding-backed score influenced evaluation; canonical §2.7 makes it mandatory.
- Replay (src/write/replay.ts): un-defer the documented deferral (replay.ts:14-15) — `MissingDependency.kind` gains the `"embedding_version"` union member (audit B3), and the availability check gains a mirrored arm: each recorded `embeddingModelVersions` entry must resolve via an adapter registry lookup (`embeddingAdapter(id)` mirroring `similarityFn(name)`; `registerEmbeddingAdapter(adapter)` keyed by `adapter.id`) to a registered adapter whose `version` matches, else the replay status is the existing missing-dependencies stratum. Because similarity versions are math-only (B2), model drift surfaces ONLY through this arm — never double-reported through the similarity check.

### 4. Relevance floor (src/algebra/similarity.ts — colocated, audit B5; split into ranked.ts only when a second RankedCorpus operator exists)

```ts
/** Filters RankedCorpus.scored to entries with score >= minScore. Empty survivors ⇒ the caller's
 *  existing structural-abstention semantics fire. Throws if minScore outside [0,1]. */
export const relevanceFloor = (minScore: number): Stage<RankedCorpus, RankedCorpus>;
```

No AST node in v1: the derive path never produces `RankedCorpus` (derive pipelines terminate in Corpus/synthesize), so compile/serialize coverage is YAGNI — recorded here deliberately.

### 5. Reference adapter (bench/longmemeval/embeddings-local.ts — NEW; devDependency)

`@huggingface/transformers` as a **devDependency**; model `bge-small-en-v1.5` quantized (~30MB, one-time download to the local HF cache, fully offline afterward; no API spend ever). Exports `createLocalEmbeddingAdapter(): Promise<EmbeddingAdapter>`. Graduates to an optional package export when the MCP dogfood slice needs it — noted, not built.

### 6. Bench arm A (bench/longmemeval/answer.ts, run.ts, adversarial-probe.ts — MOD)

```
caller-side (run.ts / probes — audit B4):
  await warmEmbeddings(adapter, cache, [...ingested record values, question])   ← async, caller's step
arm A (UNCHANGED sync signature):
  leaf → τ_valid → ⊕_dedupe(rule_weighted_avg, jaccard@0.5)        ← UNCHANGED (decision 7)
       → ⊥(keyCardinality, floor 0) → resolveDeprecateOlder → drop deprecated+flags
       → rho.by(opts.rankFn, question) → relevanceFloor(opts.relevanceFloor) → top-k
```

`AnswerOpts` gains `rankFn?: string` (default `"jaccard"` — no registry probing; the harness passes `"hybrid"` explicitly) and `relevanceFloor?: number` (default 0 = disabled, since the filter is `score >= minScore`; benchmark runs set the measured value). **`answerArmA` stays synchronous** (audit B4): warm-up is the caller's responsibility — run.ts and the probe harness warm from the records they ingested plus the question text (both already in hand) before calling arm A; a small bench helper (`warmForQuestion(adapter, cache, records, question)`) keeps that one-line. Tests using the jaccard config need no warming and stay sync; only embedding-backed test cases warm in setup. An unwarmed embedding-backed query throws (cosineOver's contract) — a loud configuration error, not silent degradation. Arm B untouched (plain-recall baseline on jaccard).

**CI constraint (hard):** `eval:lme:fixture` keeps pure-jaccard configuration — zero network, zero model, zero new devDependency exercised in CI. Unit tests use a fake adapter (below).

### 7. Single embedding abstraction (unification commitment — audit B7)

Verified at audit: **zero embedding/vector usage exists anywhere in the repo today** — this port is the first and must remain the ONLY embedding abstraction. Named future consumers, all served by this adapter unchanged:

| Consumer | Where named | How it adopts |
|---|---|---|
| MCP recall tool (`rho.jaccard` today, src/mcp/tools.ts:83) | dogfood slice | swaps to `rho.by("hybrid", ...)` + `relevanceFloor` — registration + warm-up at server startup |
| Bio associative recall (ρ+γ, v1.x recall-shaping) | bio design spec | bio processes are async (DreamFn/SummarizeFn precedent) — `await warmEmbeddings` then the same sync cache |
| Key-drift slice (probe 4; similarity-grouped consolidation/detection) | detection + this spec | injects the adapter; consolidation provenance already pre-allocates `embeddingModelVersions: {}` (consolidation-plan.ts:145) |
| Summarize/compression clustering | bio deferred list | same pattern |

Any future slice introducing a second embedding pathway is a design violation; extend this port instead.

### 8. Canonical-spec amendments (small, ADD-framed)

- Appendix B: row for the `sim_cosine` reference implementation (adapter + cache-backed, warm-up contract, [0,1] mapping).
- §4.6: note that similarity functions compose at the `SimilarityFn` level (combinators such as hybrid-max) with machine-generated component version strings recorded in provenance, and that embedding-model identity is recorded separately in `embeddingModelVersions` (per §2.7).
- Surgical inserts matching surrounding style (precedent: the detection-composition amendments).

## Error handling

- Unregistered fn name → existing `/no similarity fn/` throw (message unchanged — audit B6).
- `registerSimilarity` collision with a different fn → descriptive plain `Error`; same-object re-register → no-op.
- Cache miss → ALWAYS throws (named text hash + "run warmEmbeddings" remedy) — throw-only v1, audit B1.
- Adapter returns wrong `dim` / non-finite values → throw at `warmEmbeddings` (fail before queries).
- `relevanceFloor` minScore outside [0,1] → throw (mirrors dedupe-cutoff validation).
- Replay with unavailable embedding version → existing missing-dependencies stratum (not an error).

## Determinism & replay caveat

Pinned model + quantization + runtime version ⇒ deterministic on one machine. Cross-platform float drift can perturb late-decimal scores (and, rarely, rank order of near-ties). Replay equivalence is checked on derived claims (values/confidence), not float scores, and is conditional on version availability — the same conditionality canonical §2.7/§7 already state. Documented caveat, not engineered around.

## Measurement (acceptance evidence)

| Metric | Now | Target |
|---|---|---|
| KU recall@3 (manual benchmark) | 0.75 | **≥ 0.9** — the 5 ranking-blocked questions (6aeb4375, 852ce960, d7c942c3, 71315a70, ce6d2d27) are the named receipts |
| KU updateCorrect | 1.0 | **1.0 — hard no-regression** |
| Abstention correct | 0 | **≥ 0.6 (≥3/5)** |
| False abstentions on KU/temporal | n/a | **0** (tracked metric) |
| KU recall@10 / temporal metrics / 60-60 integrity | 1.0 / green / 60-60 | no regression |
| Probe 3 (NYC acronym) | documented expected-fail | **green** — its scheduled closure |
| Probes 1/2/4/5/6/7 | green/unchanged | unchanged |

The `relevanceFloor` value is calibrated against the hybrid score distribution on the bench and recorded (in this spec's amendment or RESULTS.md) as a measured dial.

## Testing (TDD)

- **embedding.ts (unit, CI-safe, FakeEmbeddingAdapter with hand-fixed vectors):** cosine math incl. [0,1] mapping; cache hit; miss-throw message (always throws — no fallback path exists); warm-up batching, hit-skipping, dim/finite validation failures; canonicalizeValue parity with jaccard's tokenization input; embeddingVersions = `{ [adapter.id]: adapter.version }`.
- **similarity.ts:** registerSimilarity collision/idempotency (lookup message `/no similarity fn/` unchanged); hybridMax ordering (lexical-win case, semantic-win case), math-only version-string composition, embeddingVersions merge, isPure propagation; relevanceFloor boundary (`>=`), empty-survivor output, out-of-range throw, score-order preservation.
- **replay.ts:** `embedding_version` present/absent/mismatched → correct strata; expressions with no embedding usage unaffected; similarity check never reports model drift (B2 separation).
- **provenance:** a query through `rho.by` over an embedding-backed fn records `usedSimilarityVersions[name]` (math-only) AND `usedEmbeddingModelVersions`; hybrid records merged embedding versions.
- **bench (integration, real model, NOT CI):** probe 3 green; probes 1/2/4/5/6/7 unchanged; manual benchmark hits the Measurement table; answerArmA stays sync — existing answer.test.ts cases unchanged except new embedding-backed cases that warm in setup.

## Explicitly out of scope (deliberately deferred)

- **Similarity-tolerant key matching** (probe 4) — own slice; changes `⊥` grouping semantics.
- Graceful cache-miss fallback + per-query warning routing (and the `QueryWarning` discriminated-union extension it requires) — deferred until measured demand (audit B1).
- Dedupe similarity-fn swap to cosine (cutoff space doesn't transfer; separate measured experiment).
- Sqlite embedding persistence (perf).
- RRF rank fusion; weighted-blend α (reserve dials if hybrid-max measurably fails).
- AST node / compile / serialize coverage for relevanceFloor (derive path never ranks).
- MCP wiring of the adapter + abstention surface (dogfood slice; relevanceFloor and the port are designed to be inherited there).
- `CorpusDefaults.defaultSimilarityFn` wiring (declared in canonical §3.3, absent from the code's CorpusDefaults — adding it is config-surface work for a slice that consumes it).
