# Postgres / async surface

Mneme ships two storage profiles that share one algebra:

- **Synchronous, embedded** — `createMneme` over `createSqliteAdapter`. Single-process, single-writer, zero infrastructure. This is the default (see the README Quickstart).
- **Asynchronous, networked** — `createMnemeAsync` over `createPostgresAdapter`. For hosted, multi-writer, multi-tenant deployments on managed Postgres.

The two surfaces are behaviorally equivalent — same claim algebra, same contradiction/supersession semantics, same non-destructive audit chain. A conformance suite runs one contract against both, and a parity harness asserts they produce identical served claims and bit-identical confidence. Pick the async surface when you need a shared server; keep the sync surface for embedded use.

> **Design reference:** `docs/superpowers/specs/2026-07-05-postgres-async-adapter-design.md`.
> **Spec:** canonical spec §10.4 (adapter profiles, tenant isolation, hash-chain serialization).

## Requirements

`pg` is an **optional peer dependency** — install it in the app that uses the Postgres profile:

```bash
npm install pg
```

SQLite-only consumers do not need it.

## 1. Set up the schema

Point a `pg` `Pool` at your database and apply the versioned, advisory-locked migration set. `migrate` is idempotent and safe to run concurrently from multiple booting instances.

```ts
import { Pool } from "pg";
import { migrate, MIGRATIONS } from "mneme";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const client = await pool.connect();
try {
  await migrate(client, "", MIGRATIONS); // "" = public schema; a validated "tenant_x." prefix for schema-per-tenant
} finally {
  client.release();
}
```

## 2. Wire an adapter + tenant router into `createMnemeAsync`

`createPostgresAdapter` takes a `TenantRouter` and a `tenantId`. For a single-tenant deployment, the simplest router routes every tenant to one pool with no predicate:

```ts
import { createMnemeAsync, createPostgresAdapter, dbPerTenantRouter } from "mneme";

const adapter = createPostgresAdapter({
  router: dbPerTenantRouter(() => pool),
  tenantId: "default",
});

const mneme = createMnemeAsync({ adapter, availableTiers: [{ kind: "core" }] });
mneme.createCorpus(corpusDef); // corpus catalog is in-memory; createCorpus stays synchronous
```

Corpus-catalog methods (`createCorpus`, `listCorpora`, staging) are synchronous. Everything that touches storage is `async`.

## 3. Commit, query, supersede — same algebra, awaited

```ts
import { leafAsync, asyncSigma, asyncRho, asyncKappa } from "mneme";

// write
const committed = await mneme.commit("infra:prod", {
  subject: "host:web-01",
  key: "status",
  value: "healthy",
  confidence: { distribution: "beta", parameters: { alpha: 8, beta: 1 }, raw: 8 / 9 },
  // ...profile/workspace/valid/source/provenance/evidence/tags/schema
} as never, { writer: "healthcheck" });

// read as a token-bounded context (async stage builders mirror the sync sigma/rho/kappa)
const ctx = await mneme.query("infra:prod", [
  leafAsync("infra:prod"),
  asyncSigma({ op: "subjectEq", value: "host:web-01" }),
  asyncRho.jaccard("web-01 status"),
  asyncKappa.markdown(2000),
]);
console.log(ctx.content);

// plain plan-based read (no algebra pipeline needed)
const claims = await mneme.read("infra:prod", { corpusId: "infra:prod", subject: "host:web-01" });

// belief change is explicit and auditable
await mneme.supersede("infra:prod", committed.id, {
  subject: "host:web-01",
  key: "status",
  value: "degraded",
  confidence: { distribution: "beta", parameters: { alpha: 5, beta: 4 }, raw: 5 / 9 },
  // ...
} as never, { writer: "healthcheck" });
```

`commitBatch`, `promote`, `readByIds`, and the staged-write methods (`emitCandidate`/`promoteStaged`/`promoteAllStaged`) mirror the sync surface, awaited.

## 4. Multi-tenant isolation

Tenant isolation composes *around* the existing per-corpus isolation — neither trusts caller-supplied input. Choose a `TenantRouter` per deployment:

| Provider | Isolation | Notes |
|---|---|---|
| `dbPerTenantRouter(poolFor)` | Separate database/pool per tenant | Strongest blast-radius isolation; `poolFor(tenantId)` returns the tenant's pool. |
| `schemaPerTenantRouter(pool, schemaFor)` | Separate Postgres schema per tenant | `schemaFor(tenantId)` returns a **validated** schema name (allow-list). Identifiers are schema-qualified — never via `SET search_path` (which can leak across pooled connections). |
| `rowLevelRouter(pool)` | Shared tables, enforced `tenant_id` predicate | Densest. **Requires a `tenant_id`-bearing schema** — see the caveat below. |

Concurrency is safe across tenants: the Postgres profile serializes same-corpus writers with a per-corpus advisory transaction lock (so the audit hash chain can't fork), while writers to different corpora and tenants never contend.

## Known limitations

- **Row-level tenancy needs a `tenant_id` column.** The base `MIGRATIONS` mirror the single-tenant SQLite schema and have **no `tenant_id` column**. `rowLevelRouter`'s predicate therefore targets a column a row-level deployment must add via an augmented migration set. The bundled adapter, conformance suite, and parity harness run against the base schema with a no-predicate router (`dbPerTenantRouter`/`schemaPerTenantRouter`). Row-level isolation is validated at the predicate-mechanism level only.
- **`replay` and `derive` are not on the async surface yet.** The sync `Mneme` exposes `replay`/`derive`; `AsyncMneme` omits them in this version (they read the adapter in loops and re-execute the algebra — an async refactor deferred to a follow-on). Use the sync surface if you need replay/derive.
- **Value-predicate push-down is not enabled.** The Postgres adapter reports the same conservative `fallback_in_memory` capabilities as SQLite (values are stored as `text` for byte-exact cross-backend parity, not `jsonb`). Native `jsonb` predicate push-down (§10.2) is a later optimization.
- **The MCP server uses the sync/SQLite profile.** The async surface is a library API.
