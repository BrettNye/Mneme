# Async recall/remember surface ops — design spec (2026-07-06)

Status: **DRAFT / audited** (two-lens adversarial audit 2026-07-06; amendments B1–B15 folded, see §9). Owner: async surface. Prompted by the ROADMAP follow-up
("the surface ops the tools delegate to are sync-`Session`-based — they need async-capable
variants") and a downstream consumer (the ai-os Mneme adapter) moving from embedded
SQLite (`openSession` + `recall`/`remember`/`ensureCorpus`) to managed Postgres via the
merged async adapter. Prerequisite VERIFIED: read-path-pushdown is fully merged (PR #55,
`task-shared-prefix` done) — `leafAsync` is hint-aware and recall's pure prefix
(`buildFilterPlan`, canon stages, `fromCorpus`) exists in reusable form.

Scope fences inherited: `replay`/`derive` stay OUT of the async surface (postgres design
doc A11); the MCP server stays sync/SQLite; the sync surface's behavior and signatures are
unchanged (additive only).

## 1. Problem

`createMnemeAsync` exposes only primitives (`commit`/`commitBatch`/`query`/`read`/
catalog facade — `src/mneme-async.ts:33-72`). There is no async `recall`/`remember`.
`recall` is not a thin wrapper: it carries read-time contradiction/deprecation
(`canonicalReadStages`), cardinality-safety warnings, alias-map loading, coverage
warnings, and recency-blended ranking (`src/surface/recall.ts:213-371`). A consumer
forking that loses canonical semantics, escapes the sqlite↔pg parity guarantee, and
misses read-path improvements. The retrieval semantics must have exactly one home.

## 2. Design resolution: one core over a two-method read seam

**The post-pushdown recall is already 95% pure.** Its I/O surface is exactly:

| Touch | Site | Sync mechanism |
|---|---|---|
| unknown-corpus check | `recall.ts:239` | `session.listCorpora()` (in-memory catalog) |
| cardinality resolution | `cardinality.ts:11` | `session.mneme.listCorpora(filter)` (in-memory) |
| alias-claim read | `recall.ts:73-77` | `session.mneme.read(corpus, {key: KEY_ALIAS_KEY})` |
| warm-up read | `recall.ts:209` | `session.mneme.read(corpus, plan)` |
| shared-prefix read | `recall.ts:295-299` | `mneme.query(pipe(leaf(hints), σs, canon0, canon1))` |
| ranked suffix | `recall.ts:314-318` | `mneme.query(pipe(fromCorpus, canon2, canon3, ranker))` — **zero adapter I/O** |

Both `Mneme` and `AsyncMneme` already expose **structurally identical** `listCorpora(filter?)`
(sync on both — the catalog is in-memory per the async design doc §8) and
`read(corpusId, plan)` (sync `Claim[]` vs `Promise<Claim[]>`; `await` normalizes both).
Therefore the whole orchestration extracts into ONE shared core:

```ts
// src/surface/recall.ts
/** Minimal read seam recall needs. Satisfied structurally by BOTH `Mneme` and
 *  `AsyncMneme` — sync recall passes `session.mneme`, async recall passes the
 *  AsyncMneme facade. No import of mneme-async.ts (no cycle). */
export interface RecallSource {
  listCorpora(filter?: (c: { id: string; schema?: { keyCardinality?: Record<string, "single" | "multi"> } }) => boolean): { id: string; schema?: { keyCardinality?: Record<string, "single" | "multi"> } }[];
  read(corpusId: string, plan: ExecutionPlan): Claim[] | Promise<Claim[]>;
}

async function recallCore(source: RecallSource, args: RecallArgs, deps: RecallDeps): Promise<RecallResult>;

export async function recall(session: Session, args, deps) { return recallCore(session.mneme, args, deps); }
export async function recallAsync(source: RecallSource, args, deps) { return recallCore(source, args, deps); }
```

Inside the core, the two `mneme.query` calls are replaced by **one hinted read + pure
stages** — provably byte-equivalent:

- **prefix read**: `mneme.query(pipe(leaf(corpus, hints), ...))` ≡
  `corpusOf(await source.read(corpus, { corpusId: corpus, ...hints }))` — `leaf` does
  exactly `corpusOf(ctx.adapter.query({corpusId, ...hints}))` on the scoped adapter, and
  `read` does `scopedFor(corpusId).query({...plan, corpusId})` — same plan bytes, same
  scoped adapter, same ordering (both surfaces `ORDER BY recorded_seq, id`).
- **σ**: the `mneme.ts` sigma stage calls `routeValuePredicates` before `sigmaOp`; for
  recall's predicates (`subjectEq`/`keyEq`/`keyIn` only) `collectValuePredicates` returns
  `[]` (`value-routing.ts:24-29`) — a strict no-op. Pure `sigmaOp(p)` is byte-equivalent.
- **canon stages**: arity-1 pure closures (purity pinned in `read-pipeline.test.ts`);
  apply directly.
- **ranker**: `rho.by`/`rho.blend` only (a) record similarity versions into ctx
  accumulators that `recall` discards, and (b) read `ctx.evaluationClock` — which recall
  itself supplies as `now`. The pure cores `rhoOp(name, about)` and
  `rankBlend(name, about, opts, now)` are byte-equivalent (identical unknown-fn throw).
  **One home for the dials (B10):** define `buildRecallRankerPure(args, rankFn, now):
  (c: Corpus) => RankedCorpus` (the `alpha ?? 0.5` / `halfLifeDays ?? 90` defaults live
  ONLY here); the exported Stage `buildRecallRanker` becomes a one-line ctx wrapper over
  it (explain.ts keeps its signature untouched). The core APPLIES the pure ranker at the
  position the stage executed today (after the prefix read) so throw timing for a bad
  `rankFn`/`recencyAlpha` is observably unchanged (rankBlend validates at construction;
  rho.blend deferred to execution — constructing late preserves the sync ordering).
- **`buildFilterPlan` joins the shared list (B4):** its sigmas are currently ctx-reading
  Stages (`mneme.ts` sigma calls `ctx.adapter.capabilities()`), which `recallCore` cannot
  execute — `RecallSource` deliberately has no adapter. Switch `buildFilterPlan` to build
  pure `sigmaOp(p)` stages: byte-safe (routing is a no-op for `subjectEq`/`keyEq`/`keyIn`,
  `value-routing.ts:24-29`) and arity-1 fns remain assignable to `Stage`, so explain's
  `mneme.query` pipelines and the existing `recall.test.ts` sealed-pair assertions stay
  zero-edit.
- Everything downstream (`cardinalitySafetyWarnings`, `coverageOf`, abstain/floor,
  `kappaOp`, matches mapping, warnings assembly order alias → coverage → cardinality) is
  already pure and moves verbatim.
- **Read order pinned (B13):** the core performs its reads in exactly the sync order —
  alias-read → warm-read → prefix-read. Reads are not a transaction; snapshot consistency
  holds only within the single prefix read (unchanged hazard class, but pg makes true
  concurrency reachable — documented in `recallAsync`'s JSDoc).

**Guardrails for the sync re-basing:** the golden `RecallResult` pin
(`recall-golden.test.ts`), the 100-run differential (`pushdown.property.test.ts`), and the
full suite must pass with ZERO edits — they pin the sync path byte-for-byte across this
refactor. New parity tests (§5) then pin sync-vs-async.

### Shared helpers refactored behind the seam (sync signatures unchanged)

Six sync consumers import `loadAliasContext` (census, belief-change, explain, history,
reconcile, reverse-reconcile) and it is SYNC — it must stay sync. Extraction pattern
(mirrors the async design doc's A9/A10 "pure core, per-surface I/O glue"):

- `aliasContextFrom(aliasClaims, now, keyCardinality): AliasLoadContext` — the pure
  post-read part of `loadAliasContext` (aliasMapOf + variant-cardinality warnings).
  Sync `loadAliasContext(session, ...)` keeps its exact signature and try/catch (including
  the `alias load failed — proceeding without alias expansion: ${msg}` warning text),
  delegating the pure part; `recallCore` awaits `source.read` inside an identical
  try/catch and calls the same pure function.
- `resolveKeyCardinality(session, ...)` keeps its signature; its body already only uses
  `session.mneme.listCorpora(filter)` — extract `effectiveKeyCardinality(source, corpus,
  override)` over the seam; sync fn delegates with `session.mneme`. Stays sync on both
  surfaces (catalog is in-memory).
- `warmRecallValues(session, ...)` keeps its exact signature (explain.ts consumes it);
  extract `warmRecallValuesOver(source, args, embeddings, family)`; sync fn delegates.

## 3. `rememberAsync` + corpus declaration

### 3.1 Shared candidate builder (extraction from `session.ts`)

`session.write`'s `buildCandidate` closure (`session.ts:56-73`) is the ONLY place a
`WriteRecord` becomes a `CandidateClaim`. Extract pure:

```ts
// src/surface/candidate.ts (new — WriteRecord→CandidateClaim shaping ONLY; the
// CorpusSpec→CorpusDef expansion lives in types.ts beside CorpusSpec — B11)
export interface CandidateContext {
  corpusId: string;
  schemaVersion: string;          // caller resolves per the rule below
  profile?: string;               // default SURFACE_DEFAULTS.profile
  workspace?: string;             // default corpusId
  source?: Source;                // default SURFACE_DEFAULTS.source
}
export function buildCandidateClaim(rec: WriteRecord, ctx: CandidateContext): CandidateClaim;
```

`session.ts` delegates (passing its `versionOf` lookup + `opts`) — byte-identical output,
guarded by the existing write/import suites. The schema string stays
`${corpusId}@${schemaVersion}`.

**schemaVersion resolution rule (B5):** async callers resolve it as
`def.schema.version ?? SURFACE_DEFAULTS.schemaVersion` from `listCorpora(filter)`. This
equals sync `versionOf.get()` for every session-created or sidecar-loaded corpus; a corpus
registered directly via `session.mneme.createCorpus` with a non-default version is the one
divergence case and is declared OUT of parity scope (parity fixtures declare corpora via
`corpusDefFromSpec`/`ensureCorpusAsync` only).

**Third copy killed (B11):** `test-support.ts` carries its own divergent `buildCandidate`
(`profile: "test"`); it delegates to `buildCandidateClaim` with a test `CandidateContext`
so the shape has exactly one home.

### 3.2 Shared corpus-spec expansion (extraction from `session.ts`)

`session.createCorpus`'s CorpusSpec→CorpusDef expansion — including the
scalarPseudocount validation (principles-audit finding 13), the explicit-undefined strip
(spec audit finding 2.5), and `validateKeyCardinality` — extracts to pure
`corpusDefFromSpec(spec: CorpusSpec): CorpusDef` in `types.ts` beside `CorpusSpec` (B11).
`session.createCorpus` becomes FOUR steps (B1 — binding): `corpusDefFromSpec` →
`mneme.createCorpus` → **`versionOf.set(spec.id, version)`** → sidecar `saveCorpora`
(sidecar persistence stays session-only; dropping the versionOf step would silently stamp
`@1` on writes to same-session custom-version corpora — the guard suite must include a
custom-`schemaVersion` write round-trip). Async:

```ts
export function ensureCorpusAsync(
  mneme: { createCorpus(def: CorpusDef): CorpusDef; listCorpora(filter?): {id: string}[] },
  corpusId: string,
  spec?: Omit<CorpusSpec, "id">,
): void;   // sync — catalog facade is sync on both surfaces
```

Idempotent with **first-declaration-wins semantics (B12)**: if the corpus exists, return
immediately and IGNORE the passed spec (Catalog.createCorpus is an overwriting `set`; the
exists-check is the only guard against silent redefinition — the JSDoc states this).
Defaults mirror sync `ensureCorpus` (`scopeFields: {project, person, context}` when no
spec given). **No sidecar**: the async surface's catalog is in-memory per-process (async
design doc §8) — a pg consumer re-declares its corpora at boot. Document this in the
JSDoc of BOTH `ensureCorpusAsync` and `recallAsync` (B8: a recall against a populated pg
corpus that was never re-declared this process hits the unknown-corpus early return and
serves an EMPTY result, not an error). `corpusDefFromSpec` is exported so consumers can
also call `asyncMneme.createCorpus(corpusDefFromSpec(spec))` directly.

### 3.3 `rememberAsync`

```ts
export interface RememberAsyncOptions {
  writer?: string;    // default SURFACE_DEFAULTS.writer — MUST match sync for parity
  profile?: string; workspace?: string; source?: Source;  // same defaults as openSession
}
export async function rememberAsync(
  mneme: AsyncRememberSource,   // structural: commit + read + listCorpora + createCorpus
  args: RememberArgs,
  opts?: RememberAsyncOptions,
): Promise<RememberResult>;
```

Flow mirrors sync `remember` (`remember.ts:41-77`) exactly: `ensureCorpusAsync` →
validFrom parse (same error text, same `valid: {from: validFrom ?? Date.now(), to: ∞}`
default) → `buildCandidateClaim` (schemaVersion per the B5 rule) →
`await mneme.commit(corpus, candidate, { writer })` → supersession attribution
**gated on `status === "committed"`** exactly as sync (B6 — duplicates/rejects get
`supersession: undefined`), best-effort (never throws) → `{ id, status, corpus,
supersession }`.

**Supersession attribution shares its brain, not its glue.** Sync `supersessionOutcome`
(`belief-change.ts:92-135`) is sync (called from sync `remember`) and stays untouched in
signature. Its pure attribution block (the merged/served/committed branching over
`groupDispositions` output, `belief-change.ts:108-134`) extracts to
`attributeSupersession(written, group, dispositions): SupersessionOutcome`;
`groupDispositions` is already pure and exported (`now` stays in the glue). Sync
`supersessionOutcome` = sync reads + pure core; new
`supersessionOutcomeAsync(source, corpus, claimId)` = awaited reads + the SAME pure core.
The async glue uses `readByIds(corpus, [claimId])` to locate the written claim instead of
mirroring sync's full-corpus read + `.find` (B8 — outcome-identical, avoids a per-write
O(corpus) network read on pg; the seam gains `readByIds` for the remember path only). The
only per-surface duplication is ~6 lines of read glue — the A10 precedent ("per-surface
twins, each body a one-line delegation; the parity harness is the drift guard").

## 4. Public surface & placement

- New exports from `src/surface/` barrel + root `src/index.ts`: `recallAsync`,
  `rememberAsync`, `ensureCorpusAsync`, `corpusDefFromSpec`, and types
  (`RecallSource`, `RememberAsyncOptions`). No new `package.json` exports path — the
  root barrel and existing `./surface` path cover consumers (`createMnemeAsync` is
  already root-exported). **Convention (B9):** root `index.ts` imports surface ops from
  their DEFINING modules directly, never from `./surface/index.js` (avoids the
  index→surface/index→index cycle the barrel already dodges).
- The ops are **standalone functions taking the AsyncMneme facade** (mirroring the sync
  `recall(session, args, deps)` shape with `asyncMneme` as the handle), NOT methods on
  `AsyncMneme`. Rationale: (a) mirrors the sync surface convention exactly ("signatures
  mirroring the sync ones"); (b) facade methods would import surface→mneme-async→surface,
  an ESM cycle; (c) keeps `mneme-async.ts` a primitives facade per the async design doc.
  `createMnemeAsync` is untouched → backward-compatible by construction.
- Typed errors: follow the repo's existing convention — descriptive `Error` for input
  validation (same texts as sync), `UnsupportedValuePredicateError`-style classes only
  where the repo already has them. No new error taxonomy.

## 5. Testing plan (parity is the linchpin)

1. **Sync-refactor guards (zero-edit):** `recall-golden.test.ts`,
   `pushdown.property.test.ts`, `recall.test.ts`, `explain.test.ts`, full suite +
   typecheck — all green with no test-body edits. These pin the sync path across the
   recallCore re-basing.
2. **`asyncifyAdapter` test helper** (in `src/surface/test-support.ts`): wraps a sync
   `StorageAdapter` into `AsyncStorageAdapter`. Explicit member rules (B2/B3 — binding):
   - `transaction(corpusId, fn)` is `async (_corpusId, fn) => fn()` — a **documented
     no-op passthrough, NO atomicity, single-threaded test helper only**. Delegating to
     the sync `transaction` is semantically broken: better-sqlite3 runs the fn
     synchronously, so an async fn returns a pending Promise at its first await and the
     sync transaction COMMITs empty, with the body running in autocommit afterwards.
   - `maxRecordedSeq(corpusId)` → sync `maxRecordedSeq()` (ignores corpusId — reproduces
     sync-sqlite's global sequence; within-corpus relative order, the only thing recall
     sees, is unaffected).
   - `capabilities()` stays SYNC (the async contract keeps it synchronous — do not
     promisify).
   - Promisify the remaining members; `scoped()` recurses through the wrapper; optional
     members (`putAnchoredRoot`/`getAnchoredRoots`/`close`) are defined only when present
     on the wrapped adapter (presence/absence preserved).
   Test-scoped; not barrel-exported.
3. **Fast parity (default suite, no Docker)** — `src/surface/async-ops.test.ts`:
   sync `recall` over `createMneme(sqlite)` vs `recallAsync` over
   `createMnemeAsync(asyncifyAdapter(sqlite))`, SAME store file/claims (fixed ids via the
   golden test's deterministic UUID-stub pattern where needed), same corpus def via
   `corpusDefFromSpec` — full `RecallResult` deep-equal (matches incl. ids, content,
   warnings AND order, coverage, topScore, abstained, rankFn) across the arg matrix, with
   **`asOf` pinned on EVERY arm** (B7 — the default recency blend anchors at
   `Date.now()`; unpinned runs diverge in low float bits): subject / key / subject+key /
   alias-family / no-filter / unknown-corpus / **`recencyAlpha: 1`** / **abstained**
   (`abstainBelowTop` high) / **existing-but-empty corpus** (B14), plus the golden
   three-warning fixture recipe (alias → coverage → cardinality). Same for
   `rememberAsync` vs sync `remember` (status, supersession action/deprecatedIds) and
   `ensureCorpusAsync` first-declaration-wins + validFrom error text.
   **Remember-parity determinism (B3 — binding):** fixtures pin explicit,
   pairwise-distinct `validFrom` values (same-millisecond defaults tie and
   `groupDispositions` SKIPS tied pairs, flipping `superseded` → `committed`
   nondeterministically) and reset the deterministic UUID stub to the same sequence
   before each store's write run so `deprecatedIds` compare as equal sequences.
4. **Postgres parity (Docker)** — `src/surface/async-ops.pg.test.ts`: sync `recall`
   (SQLite) vs `recallAsync` (`createMnemeAsync(createPostgresAdapter(...))`, built per
   `parity.pg.test.ts`'s `dbPerTenantRouter` pattern) — same seeded logical claims with
   fixed ids (COLLATE-"C" pattern), deep-equal `RecallResult` for the same arg matrix
   (pinned `asOf`); `rememberAsync` on pg commits and attributes supersession identically
   to sync-on-sqlite for the same write sequence (same B3 pinning rules).
   A recall that isn't parity-proven is not done.
5. **Unit**: `rememberAsync` error paths (invalid validFrom throws the sync error text;
   attribution failure never fails the write), `ensureCorpusAsync` (creates once,
   idempotent, pseudocount validation throws via `corpusDefFromSpec`), `recallAsync`
   unknown-corpus early return (empty result + coverage warning, corpus NOT created),
   alias-load failure degrades with the exact sync warning text.

## 6. Out of scope

- `replay`/`derive` on the async surface (A11 — unchanged, still deferred).
- Async twins for `explainRecall`, census, reconcile, ingest, audit, history — the seam
  (`RecallSource`) makes them mechanical follow-ons when a consumer needs them; not now.
- MCP server changes (stays sync/SQLite; ROADMAP item unchanged).
- Sidecar corpus persistence for the async surface (in-memory catalog; consumers
  re-declare at boot).

## 7. Docs

- ROADMAP: under the "MCP server backend configurable" item, mark the surface-ops
  prerequisite as delivered (async `recall`/`remember`/corpus-ensure, this spec); the
  async `replay`/`derive` item stays open.
- Postgres design doc §8: one-paragraph addendum noting the async surface ops shipped and
  where (this spec's filename).
- README "How it's used" library snippet: no change required (sync path unchanged); add
  one sentence to `docs/postgres-async-adapter.md` usage guide showing
  `recallAsync`/`rememberAsync`.
- Refresh the stale hydration-smoke comment in `pushdown.property.test.ts` ("exactly TWO
  hint-carrying reads / bound 2×5" — already false since PR #55's shared prefix; B15).
  Comment-only edit; the zero-edit rule in §5.1 applies to assertions, not to correcting
  a known-stale comment.

## 8. Delivery

Branch `feat/async-recall-remember` off `main`. Suggested task cut (DAG plan after
ratification): extractions first (candidate/corpusDef from session.ts; aliasContextFrom /
effectiveKeyCardinality / attributeSupersession / pure sigmas in buildFilterPlan / pure
ranker builder — each with zero-behavior-change guards), then recallCore + re-based sync
recall (gated on golden/differential zero-edit), then
recallAsync/rememberAsync/ensureCorpusAsync + asyncifyAdapter + fast parity, then pg
parity, then exports + docs.

## 9. Audit amendments (2026-07-06)

Two parallel adversarial audits (code-reality/repo-pattern; domain-correctness/DRY).
All folded into the sections cited.

**Binding**

- **B1 — `versionOf` bookkeeping survives the createCorpus refactor** (both lenses,
  independently): the three-step recipe dropped `versionOf.set`, silently stamping `@1`
  on same-session custom-version writes. Folded: §3.2 four-step recipe + guard test.
- **B2 — `asyncifyAdapter` transaction mapping respecified** (code-reality): delegating
  to the sync transaction commits an EMPTY transaction around an async fn
  (better-sqlite3 runs fn synchronously). Folded: §5.2 no-op passthrough, documented
  no-atomicity, test-only.
- **B3 — remember-parity determinism pinned** (domain): explicit pairwise-distinct
  `validFrom` (tied pairs are SKIPPED by `groupDispositions`, flipping outcomes) +
  per-store UUID-stub sequence reset so `deprecatedIds` compare. Folded: §5.3/§5.4.

**Minor**

- **B4 — `buildFilterPlan` switches to pure `sigmaOp` stages** (code-reality): its
  ctx-reading Stages were inapplicable inside `recallCore`; the no-op routing proof makes
  the switch byte-safe and zero-edit for explain. Folded: §2.
- **B5 — schemaVersion resolution rule** (code-reality): def-resolved version ≡ sync
  `versionOf` for all session-created corpora; direct `mneme.createCorpus` registration
  declared out of parity scope. Folded: §3.1.
- **B6 — attribution gated on `status === "committed"`** (code-reality). Folded: §3.3.
- **B7 — `asOf` pinned on every parity arm** (code-reality): recency blend anchors at
  `Date.now()`. Folded: §5.3/§5.4.
- **B8 — undeclared-corpus caveat on `recallAsync` JSDoc + `readByIds` in the async
  attribution glue** (code-reality): empty-result footgun documented at both entry
  points; per-write O(corpus) pg read avoided outcome-identically. Folded: §3.2/§3.3.
- **B9 — root-barrel import convention** (code-reality): import from defining modules,
  never `./surface/index.js`. Folded: §4.
- **B10 — ONE pure ranker builder** (domain): dial defaults get a single home; Stage
  wrapper preserves explain's signature; construction position preserves throw timing.
  Folded: §2.
- **B11 — module homes split** (domain): `buildCandidateClaim` → `candidate.ts`;
  `corpusDefFromSpec` → `types.ts` beside `CorpusSpec`; `test-support.ts`'s third
  `buildCandidate` copy delegates. Folded: §3.1/§3.2.
- **B12 — `ensureCorpusAsync` first-declaration-wins** (domain): Catalog.createCorpus
  overwrites; semantics for a second call with a different spec are now explicit.
  Folded: §3.2.
- **B13 — read order pinned (alias → warm → prefix) + snapshot note** (domain).
  Folded: §2.
- **B14 — fast-parity matrix widened** (domain): `recencyAlpha: 1`, abstained,
  existing-but-empty corpus arms; differential does NOT gain a recallAsync arm (low
  value post-re-basing — ratified). Folded: §5.3.
- **B15 — stale two-reads comment refreshed** (domain): `pushdown.property.test.ts`
  hydration-smoke comment predates the shared prefix. Folded: §7.
