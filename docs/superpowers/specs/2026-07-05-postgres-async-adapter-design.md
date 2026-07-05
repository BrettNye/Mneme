# Postgres async adapter: async surface, tenant router, shared decision core (design)

**Date:** 2026-07-05
**Status:** Approved design (post-audit), pre-implementation
**Canonical spec:** `mneme-spec-v0.2-consolidated.md` (repo root) — §5 (storage adapter contract, `StorageAdapter`), §6 (corpus isolation / `scoped()`), §7.2–7.5 (commit / supersede / promote / batch), §7.6 (replay), §8 (audit log / hash chain / anchoring), §10.2 (value-predicate capabilities). *(Section numbers not re-verified against the canonical file during this design; treat as pointers.)*
**Driven by:** a hosted, multi-tenant deployment target (RaState epistemic engine / ai-os) that standardizes on managed Postgres. The embedded single-file SQLite adapter cannot serve a shared concurrent service, and a hosted server MUST NOT block its event loop per query — ruling out any sync-over-async bridge (deasync / worker `Atomics.wait`).

## Problem

`StorageAdapter` (src/adapters/adapter.ts:67) and the entire public `Mneme` API (src/mneme.ts) are **synchronous**, riding on `better-sqlite3`'s blocking API. Postgres in Node (`pg`) is inherently async. A hosted multi-tenant service needs:

1. **A genuinely non-blocking I/O path** — per-query event-loop blocking would serialize every tenant. Sync-over-async is off the table.
2. **Multi-tenant isolation** on top of the existing per-corpus isolation (the bypass-proof `scoped()` facade that force-stamps `corpus_id`).
3. **No regression to the existing embedded path** — the MCP server, SDK consumers, and the benchmark harness keep using sync SQLite.

The enabling fact: Mneme's algebra engine is **almost entirely pure and in-memory**. `leaf` (src/algebra/expression.ts:34) calls `adapter.query()` once to load a corpus; the operators (`σ`/`τ`/`ρ`/`δ`/`κ`/aggregation) are pure `Corpus → Corpus` transforms with zero I/O. The write path (`Promoter`, src/write/pipeline.ts) is already shaped **read → decide → transaction(write)**. The sync/async boundary is therefore concentrated at the ~12 `StorageAdapter` methods and a **small, enumerated** set of algebra seams — not the algebra as a whole.

## Decisions made during brainstorming (user-ratified)

1. **Motivation:** hosted/multi-tenant server + ops/infra alignment on managed Postgres. Not primarily a SQLite-scale problem.
2. **Compat model — parallel async surface, sync path preserved.** Add an `AsyncStorageAdapter` + async `Mneme` surface for Postgres; leave `createMneme` (sync, SQLite) and every current consumer working. No breaking change, incremental delivery. **Rejected:** async-ify everything (breaking major version); server-only wrapper that re-implements ops outside the library (loses the algebra). *(Amended A13: "byte-unchanged" softened to "behavior-unchanged, additively refactored" — the sync `Promoter` gains a defaulted `clock` param and its pure decision logic is lifted out; its existing tests are the regression guard.)*
3. **Tenancy — three providers behind a `TenantRouter` seam.** `rowLevel` (shared tables, enforced `tenant_id` predicate), `schemaPerTenant` (schema-qualified identifiers), `dbPerTenant` (pool-per-tenant). Schema/DB providers are isolation-by-**routing** (identical adapter SQL, only the table-name prefix / pool differ); row-level is the one predicate-carrying path. A deployment picks per-environment and may mix. The adapter SQL is authored once.
4. **Code sharing — share pure logic, async only at I/O seams (Option 1).** Lift the *decision* logic (contradiction outcome, claim/event construction) out of the write path into pure, backend-agnostic functions both pipelines call. Write async wrappers ONLY for the read seams and the write seam. **Rejected:** generator/effect-agnostic core (churn against green code); full parallel async implementation.
5. **Driver:** `pg` (node-postgres) with pooling. **Rejected:** `postgres`(porsager) — `pg` is the ecosystem default with the widest testcontainers support.
6. **Hash-chain concurrency — per-corpus advisory lock**, taken as the first statement of every write transaction.
7. **Capabilities parity + `text` storage.** The Postgres adapter reports the SAME conservative `fallback_in_memory` value-predicate capabilities as SQLite, and stores `*_json` payloads as **`text`** (not `jsonb`) this round. jsonb + push-down is a single documented later slice (see A5).
8. **MCP server stays SQLite this round.** No MCP wiring of the async surface.

## Audit amendments (2026-07-05, post-scan, applied below)

Three parallel scanners (code-reality/repo-pattern, DRY/SRP/SoC, Postgres/async correctness) produced these binding refinements. They are folded into the Design sections; recorded here for provenance.

- **A1 (high, code-reality): the async I/O seam set is FOUR stages, not three.** `gammaStage` (src/algebra/expression.ts:53-55) calls `ctx.adapter.getClaim(id)` directly and is a compiled, exported operator (mneme.ts:136, index.ts). It is NOT a pure reused stage. `evaluateAsync` needs `gammaAsync`; the seam set is **`leaf` + `γ` + `override` + `join`** (the latter two are seams only transitively — they re-`evaluate` a sub-pipeline containing a `leaf`). `sigma` reads `ctx.adapter.capabilities()` (sync metadata) — fine, capabilities stays sync.
- **A2 (critical, correctness): schema-per-tenant must NOT rely on `SET search_path`** on pooled/reused clients — one missed reset bleeds tenant A into tenant B, and the §5 "physically impossible" claim is false for a mutable session GUC. Resolution: routing providers supply a **validated `schemaPrefix`** (from a whitelisted tenant→schema map, never raw `tenantId`) that the SQL builder prepends to table identifiers (`tenant_acme.claims`), so isolation never depends on connection session state. `dbPerTenant` uses a per-tenant pool + empty prefix. If a deployment ever keeps a session GUC, pair it with `DISCARD ALL` on release. Unknown/invalid tenant → throw at resolve.
- **A3 (high, correctness): `text`, not `jsonb`, for `*_json` this round.** jsonb does not round-trip (normalizes numbers, reorders keys, drops whitespace), so `JSON.parse(jsonb)` can differ from what was written — a live hazard for any path that RE-derives `valueHash`, and a parity-breaker. `text` gives byte-exact SQLite-TEXT parity. Safe today because `value_hash`/`entry_hash` are computed in-app and persisted as their own columns (verified: value.ts:11 computes `valueHash` pre-storage; audit-log/`canonicalEvent` hashes only scalar event fields), but `text` removes the trap entirely. jsonb graduates WITH the deferred push-down slice.
- **A4 (high, correctness): `ORDER BY recorded_seq ASC, id ASC` needs `id COLLATE "C"`.** SQLite orders text by BINARY; managed Postgres orders by a libc/ICU locale collation → different order for ids differing in case/punctuation. The tiebreaker DOES fire: the `contradictionArtifact` is inserted with the SAME `recorded_seq` as the accepted claim (pipeline.ts:181), and the non-associative confidence folds (combination.ts) consume this SQL order. Fix: `ORDER BY recorded_seq ASC, id COLLATE "C" ASC` (or declare `id` column `COLLATE "C"`).
- **A5 (high, correctness): idempotency check moves INSIDE the write transaction, after the lock.** The sync path checks before the tx (pipeline.ts:71) — a narrow window in single-writer SQLite, but under a Postgres pool two identical concurrent requests both miss and both write two claims + two chain entries. Fix: check inside the tx after the advisory lock (which already serializes same-corpus writers, so the re-check sees the prior commit), plus `idempotency(scope,key)` PK with `INSERT … ON CONFLICT DO NOTHING`. The async `write<T>` deliberately DIVERGES from the sync ordering here — documented, and the parity harness asserts idempotent-intent produces exactly one claim + one event on both backends.
- **A6 (high, correctness): lock-first ordering + driver specifics.** `pg_advisory_xact_lock` MUST be the first statement after `BEGIN`, before ANY read (contradiction query, `maxRecordedSeq`, head-read). Because it is an *xact* lock released at COMMIT, **READ COMMITTED (default) is sufficient** — a waiting writer's post-lock head-read takes a fresh snapshot that sees the prior committed event; no fork, no SERIALIZABLE needed. Use `hashtextextended(corpusId, 0)` (64-bit) not `hashtext` (32-bit) to make key collisions negligible (collisions are false contention, never a fork).
- **A7 (med, correctness): `maxRecordedSeq` is scoped to the corpus in the Postgres adapter** (`… WHERE corpus_id = $1`), so the per-corpus advisory lock fully protects the counter it reads. The spec's earlier "no duplicate recordedSeq" rationale was wrong for a GLOBAL counter under a per-corpus lock. `recordedSeq` is monotonic **per corpus**, which is all the folds/ordering require (reads are corpus-scoped). Do NOT use a Postgres `SEQUENCE` (rollbacks burn numbers → gaps diverging from SQLite). Parity runs on a single corpus so values coincide; the harness compares fold/claim results, not raw `recordedSeq` across backends.
- **A8 (high, correctness): `AsyncLocalStorage` transaction-client discipline is mandatory, not incidental.** ALS is the right tool (keeps the pooled client out of the pure core), but the spec must mandate: `try { …BEGIN/COMMIT… } catch { ROLLBACK; throw } finally { client.release(err?) }`; destroy poisoned clients (`release(err)`) when ROLLBACK itself fails; reentrant `transaction()` JOINS the active store (SAVEPOINT/flat) instead of acquiring a second client (pool-deadlock risk); seam methods outside a tx use `als.getStore() ?? pool` for autocommit; every in-tx seam call must be `await`ed.
- **A9 (med, SRP): no `decision.ts` grab-bag.** Keep the pure contradiction decision IN `contradiction.ts` (split `enforce` into the existing `findValidatedConflict` [I/O] → `decideContradiction` [pure]). Put the trivial claim/event value-object builders in `src/write/claim-build.ts` (or leave inline — they are object literals). This respects the existing home of contradiction logic instead of creating a module whose only cohesion is "pure things two pipelines call."
- **A10 (med, DRY): extract a shared sync catalog/staging facade.** `createMneme`'s corpus-catalog + staging methods (`createCorpus`, `deleteCorpus`, `listCorpora`, `emitCandidate`, `listStaged`, `discardStaged`, and the staged-promotion glue) are backend-agnostic and would be byte-identical in `createMnemeAsync`. Extract `createCatalogFacade(catalog, staging)` that both surfaces spread in. The storage-touching methods stay per-surface twins but each body is a one-line delegation, kept trivially diffable; the parity harness is the drift guard (not the type system).
- **A11 (high, scope): `replay` and `derive` are OUT of the async surface v1.** `replayStatus` (replay.ts) and `deriveClaimFrom` (derive.ts) read the adapter in loops and call `evaluate` — an async fork the extraction plan does not budget. `AsyncMneme` v1 omits them (consistent with "MCP stays SQLite"); they land in a follow-on that refactors those functions to take injected async read+evaluate. Prevents a silent, unbudgeted fork.
- **A12 (med, SoC): type the pure context minimally; don't parameterize the algebra.** Neither a global `EvalContext<A>` (infects every pure `Stage`/builder with an unused type param) nor a `Sync|Async` union (forces narrowing everywhere). Instead the pure stages take a context whose `adapter` is typed as just `{ capabilities(): AdapterCapabilities }` (both backends satisfy it, sync); only the I/O seam stages (`leafAsync`, `gammaAsync`, `overrideAsync`, `joinAsync`) close over the async adapter. `A` never reaches the pure layer.
- **A13 (med, DRY): `TenantRouter` does routing only; migration is a separate concern.** Split a free `migrate(resolved, migrations)` / `TenantMigrator` that consumes a `ResolvedConnection`; the router keeps `resolve` + `closeAll`. Lazy-ensure becomes a composable decorator, not a per-provider obligation.
- **A14 (med, prod): migration concurrency + timeouts + TLS are in-scope defaults, not deferred.** Wrap the migration runner in a fixed-key **session** advisory lock (`pg_advisory_lock`) so concurrent booting instances don't race DDL. Ship `lock_timeout` + `statement_timeout` sane defaults (a wedged per-corpus lock must surface as a retryable error, not hang the corpus and exhaust the pool). Managed Postgres mandates TLS → expose `ssl`/`sslmode`. `putIdempotencyRecord`/`putAnchoredRoot` need explicit `ON CONFLICT … DO UPDATE` (no `INSERT OR REPLACE` in Postgres); specify conflict targets `(scope,key)` and `(corpus_id,epoch_id)`.
- **A15 (low): the shared value types move to `src/adapters/adapter-types.ts` together with the `valuePredicateLevel` helper** (adapter.ts:90-94 closes over them); `adapter.ts` re-exports for byte-compatibility. `ResolvedConnection.tenantPredicate`/`schemaPrefix` carry a comment noting each is used by a subset of providers.
- **Clean bills:** `AsyncStorageAdapter` mirrors `StorageAdapter`'s 16 members with identical optionality; `Promoter.write<T>` control-flow mirror faithful; `enforce()` query→decide split faithful; `scoped()` bypass-proof isolation confirmed; idempotency helper signatures accurate; specs/plans/canonical locations correct; bio `DreamFn`/`SummarizeFn` async precedent confirmed (dreaming-types.ts:21, summarize-types.ts:10).

## Design

### 1. Async adapter contract (src/adapters/async-adapter.ts — NEW; src/adapters/adapter-types.ts — NEW)

Shared value types (`ClaimEvent`, `ExecutionPlan`, `AdapterCapabilities`, `IdempotencyRecord`, `AnchoredRootRow`, `AdapterScope`, `PredicateKind`, `ValuePredicateLevel`) and the `valuePredicateLevel` helper move to `adapter-types.ts`; `adapter.ts` re-exports them (existing importers unaffected — A15). `async-adapter.ts` imports the same types, so sync/async contracts cannot drift on shapes.

```ts
export interface AsyncStorageAdapter {
  insertClaim(claim: Claim): Promise<void>;
  getClaim(id: ClaimId): Promise<Claim | undefined>;
  deleteClaim(id: ClaimId): Promise<void>;
  insertBatch(claims: Claim[]): Promise<void>;
  query(plan: ExecutionPlan): Promise<Claim[]>;
  getIdempotencyRecord(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  putIdempotencyRecord(scope: string, key: string, rec: IdempotencyRecord): Promise<void>;
  capabilities(): AdapterCapabilities;                 // sync — static metadata (mirrors sync adapter)
  transaction<T>(corpusId: string, fn: () => Promise<T>): Promise<T>;   // corpusId EXPLICIT (A6/A8)
  maxRecordedSeq(corpusId: string): Promise<number>;   // corpus-scoped (A7)
  appendEvent(e: ClaimEvent): Promise<void>;
  readEvents(filter?: { corpusId?: string; claimId?: string; since?: number }): Promise<ClaimEvent[]>;
  putAnchoredRoot?(row: AnchoredRootRow): Promise<void>;
  getAnchoredRoots?(corpusId: string, range?: { epochId?: string; since?: number }): Promise<AnchoredRootRow[]>;
  scoped?(scope: AdapterScope): AsyncStorageAdapter;
  close?(): Promise<void>;
}
```

**`transaction(corpusId, fn)` contract (critical — A6/A8):** the body runs on a SINGLE checked-out client (`BEGIN…COMMIT`); the FIRST statement after `BEGIN` is `SELECT pg_advisory_xact_lock(hashtextextended($corpusId,0))`; every seam call inside the body runs on that same client via `AsyncLocalStorage`; mandatory `try/catch(ROLLBACK)/finally(release)` with poisoned-client destroy and reentrant-join (A8). READ COMMITTED is sufficient. `corpusId` is an explicit argument (not ambient via `scoped()`) so the lock invariant is structural — a base/unscoped `transaction` still locks correctly.

### 2. Shared decision core (src/write/contradiction.ts — MOD; src/write/claim-build.ts — NEW) (A9)

`enforce()` splits into the existing `findValidatedConflict` (I/O: `adapter.query`) → **`decideContradiction(candidate, existing, policy, corpusId): ContradictionOutcome`** (pure). The sync `Promoter` keeps calling `enforce()` (its tests guard behavior); `AsyncPromoter` calls `await adapter.query(...)` then `decideContradiction(...)`.

`claim-build.ts` holds the pure builders `buildCommittedClaim`, `buildSupersedeClaim`, `contradictionArtifact` (moved verbatim from `Promoter`), `buildCommitEvent`/`buildSupersedeEvent`/`buildPromoteEvent` — object-literal constructors shared by both promoters.

### 3. Async write pipeline (src/write/async-pipeline.ts — NEW)

`AsyncPromoter` mirrors `Promoter`'s public methods, awaiting the seams. Atomic core (note A5: idempotency INSIDE the tx):

```ts
private async write<T>(corpusId, idem, body): Promise<T> {
  return this.adapter.transaction(corpusId, async () => {          // advisory lock is 1st stmt (A6)
    if (idem?.key) {
      const prior = await checkIdempotentAsync(this.adapter, idem.scope, idem.key, this.clock());
      if (prior) return { id: prior, status: "duplicate" } as unknown as T;   // re-check sees prior commit
    }
    const recorded = this.clock();
    const seq = (await this.adapter.maxRecordedSeq(corpusId)) + 1;  // corpus-scoped (A7)
    const { result, id, event } = body(recorded, seq);             // PURE — uses claim-build.ts
    if (event) await this.adapter.appendEvent(event);
    if (idem?.key && id) await recordIdempotentAsync(this.adapter, idem.scope, idem.key, id, this.clock()); // ON CONFLICT DO NOTHING
    return result;
  });
}
```

`commit` = `await adapter.query(conflict group)` → `decideContradiction` → `write(...)`. `commitBatch` loops single commits (non-atomic §7.5). Idempotency helpers gain async siblings; the pure `idempotencyScope` is shared. **Clock injection:** both promoters take `clock: () => number` (default `Date.now`); the sync `Promoter` gains this as an additive, defaulted constructor param (A13 — refresh its tests, behavior unchanged).

### 4. Concurrency & correctness — the hash chain (A6/A7)

`appendEvent` reads the per-corpus head then appends `sha256(canonicalEvent(e) + prevHash)`. Mandatory transaction shape:

```sql
BEGIN;                                                       -- READ COMMITTED (sufficient)
SELECT pg_advisory_xact_lock(hashtextextended($corpusId,0)); -- FIRST, before any read
--   contradiction query · maxRecordedSeq(corpusId) · insert(s) · appendEvent(head-read + insert)
COMMIT;                                                       -- releases the lock
```

Because the lock releases at COMMIT and a waiting writer's post-lock head-read takes a fresh READ COMMITTED snapshot, it always sees the prior committed event — **the chain cannot fork**. The lock is keyed on `corpusId` (row-level: `tenantId||':'||corpusId`) so different corpora/tenants never contend. `maxRecordedSeq` is corpus-scoped, so the same lock that serializes the chain also protects the seq counter (A7). `recordedSeq` is monotonic per corpus.

### 5. Tenant router (src/adapters/postgres/tenant-router.ts — NEW) (A2/A13)

```ts
export interface ResolvedConnection {
  connect(): Promise<PoolClient>;                 // client from the right pool; caller releases
  schemaPrefix: string;                           // "" | validated "tenant_acme." (schema-qualified — A2)
  tenantPredicate?: { sql: string; params: unknown[] };  // row-level only (empty for routing providers)
}
export interface TenantRouter {
  resolve(tenantId: string): ResolvedConnection;  // throws on unknown/invalid tenant
  closeAll(): Promise<void>;
}
// migration is a SEPARATE concern (A13):
export function migrate(resolved: ResolvedConnection, migrations: Migration[]): Promise<void>;

export function rowLevelRouter(pool: Pool): TenantRouter;              // prefix ""; tenantPredicate = tenant_id = $
export function schemaPerTenantRouter(pool: Pool, schemaFor: (t: string) => string): TenantRouter; // validated prefix
export function dbPerTenantRouter(poolFor: (t: string) => Pool): TenantRouter;  // per-tenant pool; prefix ""
```

Isolation never depends on session state: schema-per-tenant **schema-qualifies identifiers** from a validated map (A2), db-per-tenant routes pools, row-level force-injects the predicate. All three keep `corpus_id` isolation via the existing `scoped()` mechanic — tenant isolation composes *around* it and is equally bypass-proof. `createPostgresAdapter({ router, tenantId })` binds a router+tenant into an `AsyncStorageAdapter`.

### 6. Postgres adapter + schema (src/adapters/postgres/index.ts, schema.ts, sql.ts — NEW) (A3/A4/A14)

Tables mirror SQLite (`claims`, `idempotency`, `claim_events`, `audit_anchors`), **`*_json` columns as `text`** (A3), numerics as `double precision`, `recorded_seq` as `bigint`, `claim_events.seq_pk` as `BIGSERIAL`. `id TEXT COLLATE "C"` (A4). Indexes mirror SQLite: critically `(corpus_id, subject, key, scope_hash)` and `(corpus_id, seq_pk)`. Row-level prepends a `tenant_id` column to tables/indexes/PKs. SQL builders (sql.ts) are provider-agnostic and take the `schemaPrefix`; `WHERE` gets the optional `tenantPredicate` appended; ordering is `ORDER BY recorded_seq ASC, id COLLATE "C" ASC` (A4). `query()` mirrors SQLite's `executeQuery` (forced scope first, then plan predicates). `capabilities()` = conservative all-`fallback_in_memory` (decision 7). Upserts use `ON CONFLICT (scope,key) DO UPDATE` / `ON CONFLICT (corpus_id,epoch_id) DO UPDATE` (A14); idempotency insert uses `ON CONFLICT DO NOTHING` (A5).

### 7. Migrations (src/adapters/postgres/schema.ts) (A13/A14)

Hand-rolled, ordered, idempotent DDL tracked in `mneme_migrations(version int primary key, applied_at)` per schema/db. The runner takes a **fixed-key session advisory lock** (`pg_advisory_lock(MIGRATION_KEY)`) so concurrent booting instances serialize (A14). Tenancy multiplies the target, not the set: row-level runs once; schema-per-tenant `migrate()`s a resolved connection lazily on first touch + `migrateAllTenants(tenants)` for deploys; db-per-tenant points the runner at each pool. `CREATE INDEX CONCURRENTLY` on a live large tenant is a documented special case (cannot run inside the migration tx).

### 8. Async public surface (src/mneme-async.ts — NEW; src/catalog-facade.ts — NEW) (A10/A11)

`createCatalogFacade(catalog, staging)` holds the backend-agnostic corpus-catalog + staging methods; both `createMneme` and `createMnemeAsync` spread it in (A10). `createMnemeAsync({ adapter: AsyncStorageAdapter, availableTiers }): AsyncMneme` — the async twin of `Mneme` for storage-touching methods (`commit`, `commitBatch`, `query`, `supersede`, `promote`, `read`, `readByIds`, staged-*), each a one-line delegation. **`replay` and `derive` are omitted in v1** (A11). Catalog methods stay sync. `query()` builds a full async `EvalContext` mirroring ALL seven fields of the sync path (adapter, catalog, evaluationClock, usedSimilarityVersions, usedEmbeddingModelVersions, onWarning, fallbackWarnThreshold — A12/audit#12) and keeps the `scopedFor` capabilities re-stamp (mneme.ts:286-292), then calls `evaluateAsync`.

### 9. Async evaluation (src/algebra/async-expression.ts — NEW) (A1/A12)

`evaluateAsync(pipeline, ctx): Promise<O>` awaits the four I/O-touching stage kinds and delegates everything else to the existing pure operators:

- `leafAsync(corpusId)` → `await ctx.adapter.query(plan)` → in-memory `Corpus`.
- **`gammaAsync(depth)`** → provenance traversal awaiting `ctx.adapter.getClaim` (A1 — γ is NOT pure).
- `overrideAsync` / `joinAsync` → await the right sub-pipeline via `evaluateAsync`, then call the SAME pure `override`/`join` combine functions.

Every pure stage (`σ`, `τ`, `ρ`, `δ`, `κ`, all `α`/aggregation, `reweight`) is imported and reused unchanged, run synchronously between awaits. Pure stages receive a context whose `adapter` is typed minimally as `{ capabilities(): AdapterCapabilities }`; only the seam stages close over the full async adapter (A12).

## Error handling

- Pool/connection failure → the async method's Promise rejects with the underlying `pg` error; `transaction` bodies ROLLBACK then re-raise; **`finally` always `release`s** the client (poisoned clients destroyed via `release(err)` — A8).
- `lock_timeout` + `statement_timeout` shipped as defaults (A14): a wedged advisory lock surfaces as a retryable error, never an unbounded corpus-wide hang.
- TLS: `ssl`/`sslmode` exposed for managed Postgres (A14).
- Unknown corpus → same `catalog.getCorpus` throw as sync. Missing/invalid `tenantId` → throw at `resolve`/adapter construction (never silently unscoped).
- Batch (§7.5): per-item error → `status: "error"`, no rollback of prior successes, `stopOnError` respected.
- Idempotency race closed inside the tx via re-check + `ON CONFLICT DO NOTHING` (A5).

## Testing (TDD)

- **Adapter conformance reuse (linchpin).** Factor `src/adapters/adapter.test.ts` assertions into a backend-agnostic contract suite run against the Postgres adapter (and a sync→async shim for SQLite). Same contract, both backends — the type system does NOT prevent drift; this suite does.
- **Backend:** **Testcontainers (real Postgres) for everything load-bearing** — advisory locks, transaction/rollback, hash chain, `COLLATE "C"` ordering, `search_path`/schema-prefix isolation, `ON CONFLICT`, sequences. **pg-mem is restricted to pure single-connection SQL-shape unit tests** (WHERE-builder, param binding, row mapping) — it faithfully models none of advisory locks, MVCC isolation, jsonb, collation, or schema switching (A8/audit#8), so nothing in the concurrency/isolation/determinism paths may rely on it.
- **decision.ts→contradiction.ts (pure, CI-safe):** `decideContradiction` parity against current `enforce()` golden cases (lifted from contradiction.test.ts); claim/event builders byte-identical to today's inline construction.
- **Concurrency (real Postgres):** N parallel `commit`s to one corpus → unforked, hash-verifiable chain (recompute each `entryHash` from `prevHash`); no same-corpus duplicate `recordedSeq`; cross-corpus writers proceed concurrently; **idempotent-intent under concurrency → exactly one claim + one event** (A5).
- **Round-trip parity (A3):** `fromRow(toRow(c)).value` deep-equals `c.value` for values containing floats / large ints / duplicate keys — passes on `text`, would fail on jsonb (the proof `text` is required).
- **Determinism (A4):** insert an accepted+contradiction-artifact pair (same `recorded_seq`) with ids that sort differently under libc vs C; assert identical fold confidence on SQLite and Postgres.
- **tenant-router (per provider):** resolve + isolate; cross-tenant leakage impossible (routing / schema-qualified) or predicate-blocked (row-level); invalid tenant throws; `migrate()` idempotent + session-lock-serialized.
- **Parity harness:** same corpus + write sequence + query pipeline through sync-SQLite and async-Postgres; assert identical claims, bit-identical confidence, AND identical event ordering/idempotency timing (guards the write-orchestration twin — audit#3). Single-corpus (so `recordedSeq` values coincide — A7).
- **async-expression:** `evaluateAsync` over `leaf/γ/σ/τ/ρ/κ/override/join` matches sync `evaluate` on the same in-memory data.
- **CI:** unit/pure + pg-mem shape tests run with zero Docker on the default `npm test`; the Testcontainers suite is a separate `test:pg` script gated on Docker.

## Canonical-spec amendments (small, ADD-framed)

- §5: the adapter contract has a synchronous embedded profile (`StorageAdapter`) and an asynchronous server profile (`AsyncStorageAdapter`) sharing one set of value types; the algebra is backend-agnostic because I/O is confined to the `leaf`/`γ`/binary-operator seams.
- §6: multi-tenant isolation composes *around* corpus isolation via a `TenantRouter` (schema-qualified routing, per-tenant pool, or enforced predicate), never trusting caller input.
- §8: the hash chain requires per-corpus write serialization; the Postgres profile achieves it with a lock-first per-corpus advisory transaction lock under READ COMMITTED (SQLite: IMMEDIATE).

## Slice order (for writing-dag-plans; non-binding)

1. `adapter-types.ts` extraction (+ `valuePredicateLevel`) + `AsyncStorageAdapter` interface + contradiction split (`decideContradiction`) + `claim-build.ts` + `createCatalogFacade` — pure refactor; sync stays behavior-green.
2. Postgres adapter (sql.ts/schema.ts/index.ts), **row-level single-tenant**, `text` columns, `COLLATE "C"`, lock-first `transaction`, ON-CONFLICT upserts + the conformance suite (Testcontainers).
3. `evaluateAsync` (+ `gammaAsync`) + async binary operators + `AsyncPromoter` + `createMnemeAsync`.
4. `TenantRouter` + `rowLevel` + one routing provider fully; `dbPerTenant` + `migrateAllTenants` as a thin follow-on (A14/audit#11 — migration orchestration is the deferrable part).
5. Concurrency hardening (advisory lock, `lock_timeout`/`statement_timeout`, migration session-lock, TLS) + parity/determinism/round-trip harnesses + `test:pg` CI wiring.

## Explicitly out of scope (deliberately deferred)

- **`replay` / `derive` on the async surface** (A11) — follow-on that injects async read+evaluate into `replayStatus`/`deriveClaimFrom`.
- **Async-ifying the existing sync/SQLite path** — the parallel surface is the point.
- **MCP server on the async surface** — stays SQLite; designed to be inherited.
- **`jsonb` storage + value-predicate push-down** (`native_indexed`/`native_unindexed`) — one later slice; `text` + conservative capabilities first (A3/decision 7).
- **Cross-tenant / cross-corpus queries** — out of the isolation model by construction.
- **Anchoring signature backends / `readEvents` streaming** — SQLite semantics ported verbatim; the unbounded full-corpus event load for Merkle anchoring (audit#9) is a pre-existing scale note, not addressed here.
- **A generator/effect-agnostic unified core** — revisit only if a third backend appears.
