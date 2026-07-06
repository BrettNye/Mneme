// Versioned Postgres DDL + a migration runner for the pg adapter.
//
// Mirrors src/adapters/sqlite.ts's table shapes (claims, idempotency,
// claim_events, audit_anchors) and column names, but Postgres-native with a
// few deliberate binding choices for byte-exact parity with the SQLite adapter:
//   - `*_json` columns are `text` (NOT jsonb — jsonb re-serializes and would
//     not round-trip byte-for-byte against SQLite TEXT).
//   - numerics are `double precision`; `recorded_seq` is `bigint`;
//     `claim_events.seq_pk` is `BIGSERIAL PRIMARY KEY`.
//   - `id` is `text COLLATE "C"` so ordering matches SQLite's binary (byte
//     order) collation — the pg adapter's queries ORDER BY id COLLATE "C".
//
// Every table identifier is prefixed with a `schemaPrefix` string so a caller
// can namespace the tables into a Postgres schema (e.g. `"tenant_a."`) or use
// the default (`""`). Index names are left unprefixed: an index lives in the
// schema of the table it indexes, so per-schema prefixing of the table is
// enough to keep index identifiers from colliding across schemas.
//
// TRUST BOUNDARY: `schemaPrefix` is interpolated VERBATIM into DDL/DML as a
// raw SQL identifier (template-string concatenation, not a parameterized
// value -- Postgres has no bind-parameter form for identifiers). This module
// does NOT escape or quote it. `migrate()` runs a cheap allow-list guard
// (empty string, or a single lowercase identifier followed by a dot) as
// defense-in-depth, but callers remain responsible for only ever passing
// `""` or a `schemaPrefix` that was itself validated/allow-listed upstream
// (e.g. produced by a tenant router from a known-safe tenant id) -- never a
// raw, unvalidated value from user input.
import type { PoolClient } from "pg";

export interface Migration {
  version: number;
  up: (prefix: string) => string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (p) => `
      CREATE TABLE IF NOT EXISTS ${p}claims (
        id text COLLATE "C" PRIMARY KEY,
        corpus_id text,
        profile text,
        workspace text,
        subject text,
        key text,
        scope_hash text,
        scope_json text,
        value_json text,
        value_hash text,
        conf_distribution text,
        conf_params text,
        conf_raw double precision,
        conf_effective double precision,
        valid_from double precision,
        valid_to double precision,
        recorded double precision,
        recorded_seq bigint,
        status text,
        source text,
        provenance_json text,
        evidence_json text,
        audience_json text,
        tags_json text,
        schema text,
        run_id text
      );
      CREATE INDEX IF NOT EXISTS idx_claims_corpus_identity ON ${p}claims(corpus_id, subject, key, scope_hash);
      CREATE INDEX IF NOT EXISTS idx_claims_corpus ON ${p}claims(corpus_id);
      CREATE INDEX IF NOT EXISTS idx_claims_pks ON ${p}claims(profile, key, scope_hash);
      CREATE INDEX IF NOT EXISTS idx_claims_subject ON ${p}claims(subject);
      CREATE INDEX IF NOT EXISTS idx_claims_run_id ON ${p}claims(run_id);
      CREATE INDEX IF NOT EXISTS idx_claims_recorded_seq ON ${p}claims(recorded_seq);

      CREATE TABLE IF NOT EXISTS ${p}idempotency (
        scope text,
        key text,
        result text,
        created_at double precision,
        PRIMARY KEY (scope, key)
      );

      CREATE TABLE IF NOT EXISTS ${p}claim_events (
        seq_pk BIGSERIAL PRIMARY KEY,
        op text,
        corpus_id text,
        writer text,
        claim_id text,
        deprecated_id text,
        to_status text,
        reason text,
        recorded double precision,
        recorded_seq bigint,
        entry_hash text,
        prev_hash text
      );
      CREATE INDEX IF NOT EXISTS idx_events_claim ON ${p}claim_events(claim_id);
      CREATE INDEX IF NOT EXISTS idx_events_corpus_seq ON ${p}claim_events(corpus_id, seq_pk);

      CREATE TABLE IF NOT EXISTS ${p}audit_anchors (
        corpus_id text,
        epoch_id text,
        root text,
        signature text,
        guarantee text,
        at double precision,
        PRIMARY KEY (corpus_id, epoch_id)
      );
    `,
  },
  {
    version: 2,
    up: (p) => `
      ALTER TABLE ${p}claims        ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT '';
      ALTER TABLE ${p}claim_events  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT '';
      ALTER TABLE ${p}idempotency   ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT '';
      ALTER TABLE ${p}audit_anchors ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_claims_tenant_identity ON ${p}claims(tenant_id, corpus_id, subject, key, scope_hash);
      CREATE INDEX IF NOT EXISTS idx_events_tenant_corpus_seq ON ${p}claim_events(tenant_id, corpus_id, seq_pk);
      ALTER TABLE ${p}idempotency   DROP CONSTRAINT IF EXISTS idempotency_pkey;
      ALTER TABLE ${p}idempotency   ADD CONSTRAINT idempotency_pkey PRIMARY KEY (scope, key, tenant_id);
      ALTER TABLE ${p}audit_anchors DROP CONSTRAINT IF EXISTS audit_anchors_pkey;
      ALTER TABLE ${p}audit_anchors ADD CONSTRAINT audit_anchors_pkey PRIMARY KEY (tenant_id, corpus_id, epoch_id);
    `,
  },
];

// Fixed, constant key for the session advisory lock. All booting instances take
// THE SAME lock so concurrent DDL application serializes (Postgres has no
// transactional `CREATE TABLE IF NOT EXISTS` race guard on its own — two
// runners can both see a version un-applied and both try to insert it).
const MIGRATION_LOCK_KEY = 0x6d6e656d; // "mnem"

// Defense-in-depth allow-list for `schemaPrefix`: empty, or exactly one
// lowercase SQL identifier followed by a dot (the form the pg tenant router
// is expected to produce). This does NOT make raw interpolation "safe" in
// general -- it just converts an unvalidated caller mistake (or a prefix
// that leaked unsanitized user input) into a loud, immediate throw instead
// of silently building attacker-controlled DDL. See the trust-boundary note
// at the top of this file.
const SCHEMA_PREFIX_PATTERN = /^[a-z_][a-z0-9_]*\.$/;

function assertValidSchemaPrefix(schemaPrefix: string): void {
  if (schemaPrefix !== "" && !SCHEMA_PREFIX_PATTERN.test(schemaPrefix)) {
    throw new Error(
      `Invalid schemaPrefix ${JSON.stringify(schemaPrefix)}: must be "" or ` +
        `match ${SCHEMA_PREFIX_PATTERN} (a single lowercase identifier ` +
        `followed by a dot). schemaPrefix is interpolated verbatim as a SQL ` +
        `identifier and is NOT escaped -- see the trust-boundary note at the ` +
        `top of schema.ts.`
    );
  }
}

/**
 * Apply un-applied migrations in ascending version order, serialized across
 * concurrent booting instances via a fixed-key SESSION advisory lock.
 *
 * @param client       a `pg` PoolClient (session-scoped so the advisory lock
 *                     is held for the duration of this call).
 * @param schemaPrefix identifier prefix for every table (e.g. `"tenant_a."` or `""`).
 *                     TRUST BOUNDARY: interpolated verbatim as a raw SQL
 *                     identifier -- NOT escaped by this module. Callers MUST
 *                     validate/allow-list it (empty string, or a validated
 *                     `<schema>.` produced by the tenant router) before
 *                     calling `migrate`. A cheap runtime guard rejects
 *                     anything outside that shape, but that is
 *                     defense-in-depth, not a substitute for caller
 *                     validation.
 * @param migrations   the migration set to apply (defaults to `MIGRATIONS`).
 *
 * Idempotent: applying twice, or two concurrent runners, yields exactly
 * `migrations.length` rows in `${schemaPrefix}mneme_migrations` with no error.
 * Corollary: every `Migration.up()` MUST itself be fully re-runnable
 * (idempotent DDL, e.g. `IF NOT EXISTS`) -- a crash between a migration's
 * DDL and its tracking-row INSERT replays that same `up()` on next boot.
 */
export async function migrate(
  client: PoolClient,
  schemaPrefix: string,
  migrations: Migration[] = MIGRATIONS
): Promise<void> {
  assertValidSchemaPrefix(schemaPrefix);
  // SESSION-level lock: blocks until acquired, held until we explicitly unlock
  // in the finally below. Any second runner waits here until the first releases.
  await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schemaPrefix}mneme_migrations (version int primary key, applied_at double precision)`
    );
    const { rows } = await client.query(
      `SELECT version FROM ${schemaPrefix}mneme_migrations`
    );
    const applied = new Set<number>(rows.map((r) => r.version as number));

    for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
      if (applied.has(m.version)) continue;
      await client.query(m.up(schemaPrefix));
      await client.query(
        `INSERT INTO ${schemaPrefix}mneme_migrations (version, applied_at) VALUES ($1, $2)`,
        [m.version, Date.now()]
      );
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
  }
}
