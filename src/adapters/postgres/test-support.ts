// Sole owner of the Postgres test fixture: every other pg testcontainers
// suite (that wants a ready-migrated pool rather than driving `migrate`
// itself) imports `startPg`/`withPostgres`/`sampleClaim` from here instead
// of re-implementing container bootstrap.
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { migrate, MIGRATIONS } from "./schema.js";
import type { Claim } from "../../core/claim.js";
import { newClaimId } from "../../core/ids.js";

/**
 * Boots exactly one `postgres:16` container, creates a `pg` `Pool` bound to
 * it, and applies `MIGRATIONS` to the public schema. Callers MUST call
 * `stop()` (in a `finally`) to end the pool and stop the container.
 */
export async function startPg(): Promise<{ pool: Pool; stop: () => Promise<void> }> {
  const container = await new PostgreSqlContainer("postgres:16").start();
  let pool: Pool | undefined;
  try {
    pool = new Pool({ connectionString: container.getConnectionUri() });
    const client = await pool.connect();
    try {
      await migrate(client, "", MIGRATIONS);
    } finally {
      client.release();
    }
    return {
      pool,
      stop: async () => {
        try {
          await pool!.end();
        } finally {
          await container.stop();
        }
      },
    };
  } catch (err) {
    await pool?.end().catch(() => {});
    await container.stop().catch(() => {});
    throw err;
  }
}

/** Callback sugar over `startPg()` with guaranteed `finally` teardown. */
export async function withPostgres(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const { pool, stop } = await startPg();
  try {
    await fn(pool);
  } finally {
    await stop();
  }
}

/**
 * A deterministic, minimal VALID `Claim` (all required fields populated),
 * for round-trip / chain assertions across the pg suites. Fields are
 * overridable via `over`.
 */
export function sampleClaim(over: Partial<Claim> = {}): Claim {
  const base: Claim = {
    id: newClaimId(),
    profile: "test-profile" as Claim["profile"],
    workspace: "test-workspace" as Claim["workspace"],
    subject: "project:sample",
    key: "project.status",
    scope: { project: "sample" },
    scopeHash: "_",
    value: "active",
    valueHash: "0000000000000000",
    confidence: { distribution: "scalar", parameters: { p: 0.9 }, raw: 0.9 },
    valid: { from: 0, to: Number.POSITIVE_INFINITY },
    recorded: 0,
    recordedSeq: 1,
    status: "validated",
    source: "manual",
    provenance: {},
    evidence: [],
    audience: {},
    tags: [],
    schema: "v1",
  };
  return { ...base, ...over };
}
