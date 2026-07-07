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
| `rowLevelRouter(pool)` | Shared tables, enforced `tenant_id` column | Densest (many tenants in shared tables). Works on the base schema — the migrations include a `tenant_id` column, and the adapter stamps/filters it on every write/read. |

With `rowLevelRouter`, tenants may **share a corpus namespace** — the adapter stamps and filters a `tenant_id` on every write/read across all four tables (claims, events, idempotency, anchors), and the per-corpus advisory lock composes tenant + corpus, so two tenants using the same corpus name get separate, non-forking audit chains. Concurrency is safe across tenants: same-(tenant,corpus) writers serialize (the chain can't fork); different corpora or tenants never contend.

## Surface ops

High-level recall/remember operations are available on the async surface, mirroring the sync `Session` API. The async surface has **no persistent corpus registry** (catalog is in-memory per process) — consumers must re-declare corpora at boot via `ensureCorpusAsync`.

```ts
import { 
  createMnemeAsync, 
  createPostgresAdapter, 
  dbPerTenantRouter,
  ensureCorpusAsync,
  rememberAsync,
  recallAsync,
} from "mneme";

const adapter = createPostgresAdapter({
  router: dbPerTenantRouter(() => pool),
  tenantId: "default",
});

const mneme = createMnemeAsync({ adapter, availableTiers: [{ kind: "core" }] });

// Declare corpus at boot (re-declaration is safe; first-declaration-wins if exists).
ensureCorpusAsync(mneme, "work");

// Write with belief-change attribution (async).
const committed = await rememberAsync(mneme, {
  subject: "task:implement-feature",
  key: "status",
  value: "in-progress",
  corpus: "work",
  confidence: 0.9,
});

// Read with alias expansion, ranking, and coverage warnings (async).
const result = await recallAsync(mneme, {
  about: "current task status",
  corpus: "work",
  subject: "task:implement-feature",
  limit: 3,
}, { embeddings: { rankFn: "jaccard" } });
```

**Note:** If a corpus is populated in Postgres but never declared in the current process via `ensureCorpusAsync`, `recallAsync` returns an empty result (not an error) — the corpus is unknown to the in-memory catalog. Re-declare at boot before any recall queries.

## Known limitations

- **`replay` and `derive` are not on the async surface yet.** The sync `Mneme` exposes `replay`/`derive`; `AsyncMneme` omits them in this version (they read the adapter in loops and re-execute the algebra — an async refactor deferred to a follow-on). Use the sync surface if you need replay/derive.
- **Value-predicate push-down is not enabled.** The Postgres adapter reports the same conservative `fallback_in_memory` capabilities as SQLite (values are stored as `text` for byte-exact cross-backend parity, not `jsonb`). Native `jsonb` predicate push-down (§10.2) is a later optimization.
- **The MCP server uses the sync/SQLite profile.** The async surface is a library API.
