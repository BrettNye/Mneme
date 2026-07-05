// Docker-only (gated by the `.pg.test.ts` suffix -> `npm run test:pg`).
//
// Boots its OWN raw postgres:16 container and drives `migrate` directly. It
// deliberately does NOT use the shared withPostgres fixture: that fixture calls
// migrate() internally, so using it here would be testing the fixture, not the
// migration runner this file is meant to validate.
//
// testcontainers v10 splits per-technology containers into `@testcontainers/*`
// packages; `PostgreSqlContainer` is not exported from the base `testcontainers`
// package. We use the base `GenericContainer` (always available) with the
// postgres:16 image directly — equivalent for this test's purposes.
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Pool } from "pg";
import { describe, it, expect } from "vitest";
import { migrate, MIGRATIONS } from "./schema.js";

async function startPostgres(): Promise<StartedTestContainer> {
  return new GenericContainer("postgres:16")
    .withEnvironment({
      POSTGRES_USER: "test",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "test",
    })
    .withExposedPorts(5432)
    // Postgres logs the ready line twice (initdb bootstrap, then real start);
    // wait for the SECOND so the accepting socket is the durable one.
    .withWaitStrategy(
      Wait.forLogMessage("database system is ready to accept connections", 2)
    )
    .start();
}

function connectionUri(c: StartedTestContainer): string {
  return `postgresql://test:test@${c.getHost()}:${c.getMappedPort(5432)}/test`;
}

describe("postgres schema migrate", () => {
  it("is idempotent across two concurrent runners", async () => {
    const container = await startPostgres();
    const pool = new Pool({ connectionString: connectionUri(container) });
    try {
      const [c1, c2] = [await pool.connect(), await pool.connect()];
      // Two concurrent runners: the fixed-key session advisory lock must
      // serialize them so exactly MIGRATIONS.length rows land, with no error.
      await Promise.all([migrate(c1, ""), migrate(c2, "")]);
      c1.release();
      c2.release();

      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM mneme_migrations"
      );
      expect(rows[0].n).toBe(MIGRATIONS.length);

      // Core tables exist.
      for (const t of ["claims", "idempotency", "claim_events", "audit_anchors"]) {
        const r = await pool.query("SELECT to_regclass($1) AS c", [t]);
        expect(r.rows[0].c).toBe(t);
      }
    } finally {
      await pool.end();
      await container.stop();
    }
  }, 120000);

  it("applying twice yields exactly MIGRATIONS.length rows", async () => {
    const container = await startPostgres();
    const pool = new Pool({ connectionString: connectionUri(container) });
    try {
      const c = await pool.connect();
      await migrate(c, "");
      await migrate(c, "");
      c.release();

      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM mneme_migrations"
      );
      expect(rows[0].n).toBe(MIGRATIONS.length);
    } finally {
      await pool.end();
      await container.stop();
    }
  }, 120000);

  it("honors the schemaPrefix for every table identifier", async () => {
    const container = await startPostgres();
    const pool = new Pool({ connectionString: connectionUri(container) });
    try {
      const c = await pool.connect();
      await c.query('CREATE SCHEMA IF NOT EXISTS "tenant_a"');
      await migrate(c, 'tenant_a.');
      c.release();

      // Prefixed tables land in the tenant schema, not the default one.
      const there = await pool.query(
        "SELECT to_regclass('tenant_a.claims') AS c"
      );
      expect(there.rows[0].c).toBe("tenant_a.claims");
      const notHere = await pool.query("SELECT to_regclass('public.claims') AS c");
      expect(notHere.rows[0].c).toBeNull();

      // id column is binary-collated text; recorded_seq is bigint.
      const cols = await pool.query(
        `SELECT column_name, data_type FROM information_schema.columns
           WHERE table_schema = 'tenant_a' AND table_name = 'claims'
           AND column_name IN ('id', 'recorded_seq', 'scope_json', 'conf_raw')`
      );
      const byName = Object.fromEntries(
        cols.rows.map((r) => [r.column_name, r.data_type])
      );
      expect(byName.id).toBe("text");
      expect(byName.recorded_seq).toBe("bigint");
      expect(byName.scope_json).toBe("text");
      expect(byName.conf_raw).toBe("double precision");
    } finally {
      await pool.end();
      await container.stop();
    }
  }, 120000);
});
