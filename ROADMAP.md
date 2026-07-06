# Mneme roadmap

A living tracker for near-term follow-ups. Broader design context lives in
`docs/superpowers/specs/` and the canonical spec (`mneme-spec-v0.2-consolidated.md`);
this file is the lightweight "what's next / what's owed" list.

## Recently shipped — Postgres async adapter

- **Async surface** — `AsyncStorageAdapter`, `createMnemeAsync`, `createPostgresAdapter`, `TenantRouter` (3 providers) beside the untouched sync/SQLite path; pure algebra reused, async only at the I/O seams; per-corpus advisory-lock hash chain. — PR #50
- **Docs + exports** — `docs/postgres-async-adapter.md` usage guide, canonical spec §10.4, and completed public exports (`migrate`/`MIGRATIONS` + async query builders). — PR #51
- **CI** — GitHub Actions: a unit job (typecheck + build + default suite) and a Docker-gated Postgres job (testcontainers). — PR #52
- **Row-level multi-tenancy** — explicit `tenant_id` column (uniform stamp/filter across all four tables, per-(tenant,corpus) chain partition, tenant-composed lock key). Spec + opus security reviewed. — PR #53

## Follow-ups

### Hardening & cleanup (non-blocking)

- [ ] **Lifecycle-constant DRY** — `AsyncPromoter` (`src/write/async-pipeline.ts`) copy-duplicates `LIFECYCLE_ORDER` + `isForwardTransition` from the sync `Promoter` (`src/write/pipeline.ts`) because they aren't exported. Hoist both into a shared `src/write/lifecycle.ts` so the forward-transition tables can't drift.
- [ ] **pg `withTx` helper + base-batch timeouts** — the standalone base (unscoped) `insertBatch` in `src/adapters/postgres/index.ts` hand-duplicates `transaction()`'s connect/BEGIN/ROLLBACK/release discipline and omits `SET LOCAL lock_timeout`/`statement_timeout`. Extract a shared `withTx(lockKey?, fn)` so the base path inherits the timeouts and there's one release-discipline implementation.
- [ ] **`schemaPerTenantRouter` 63-byte bound** — the schema-name allow-list (`^[a-z_][a-z0-9_]*$`) has no length cap; Postgres truncates identifiers at 63 bytes, so two long names differing only after byte 63 could collide. Add a `length <= 63` check.
- [ ] **Reentrancy assert in pg `transaction()`** — the reentrant-join branch ignores the nested `corpusId` and rides the outer advisory lock, assuming nested == outer (single-corpus-per-tx usage). Add an assertion so a differently-scoped nested `transaction()` fails loudly instead of reading an unserialized chain head.
- [ ] **Flaky `src/cli/main.test.ts`** — intermittently times out at 5s under heavy parallel load (passes in isolation ~4.7s). Bump its per-test timeout or reduce setup cost. CI will now surface it if it recurs.

### Deferred features

- [ ] **Async `replay` + `derive`** on `AsyncMneme` (spec A11) — `createMnemeAsync` omits them. Refactor `replayStatus` (`src/write/replay.ts`) and `deriveClaimFrom` (`src/write/derive.ts`) to take injected async read+evaluate callables, then expose them. **Prioritized next (2026-07-06):** this is the only place a consumer can observe "Mneme on pg" behaving differently from "Mneme on sqlite" — Postgres is reachable only via the async surface, so a pg consumer today has no replay/derive. Close before any pg consumer goes live; everything else is parity-enforced (shared algebra, conformance contract, byte-parity suite).
- [ ] **MCP server backend configurable** (2026-07-06) — `openMnemeEngine` (`src/mcp/engine.ts`) hardcodes the sync SQLite adapter; `MNEME_DB` only picks the file path. Add backend selection (e.g. `MNEME_BACKEND=sqlite|postgres` + connection env) so the same MCP server can run against the Postgres/async adapter. Real prerequisite: the surface ops the tools delegate to are sync-`Session`-based — they need async-capable variants (or the engine needs an async session) before a pg backend can be wired; async `replay`/`derive` above completes the picture if replay/derive tools ever land. This is the concrete first step toward the hosted multi-tenant server below.
- [ ] **jsonb value-predicate push-down** (Postgres, spec §10.2) — the adapter stores `*_json` as `text` (byte-exact cross-backend parity) and reports all-`fallback_in_memory` capabilities. A later optimization adds a jsonb indexed path reporting `native_indexed`/`native_unindexed` for equality/containment — must not break the sqlite↔pg parity harness (jsonb does not round-trip byte-for-byte). Only when value-predicate query load justifies it.

### Larger, opt-in

- [ ] **Async MCP server / hosted deployment** — the MCP server stays on the sync/SQLite profile; wiring the async surface into a hosted multi-tenant server is the eventual target (the reason the async path exists).

---

*The stoa vault was offline when these were captured, so this file is their durable home.
Also mirrored in the session task list. Check items off as they land.*
