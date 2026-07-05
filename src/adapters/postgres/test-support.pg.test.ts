// Docker-only (gated by the `.pg.test.ts` suffix -> `npm run test:pg`).
//
// Self-test for test-support.ts's OWN startPg/withPostgres/sampleClaim. Uses
// its own startPg() call (not a shared fixture-of-a-fixture) to prove the
// bootstrap this module hands to every other pg suite actually works.
import { describe, it, expect, vi, type MockInstance } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import type { StartedTestContainer } from "testcontainers";
import { Pool } from "pg";
import { startPg, withPostgres, sampleClaim } from "./test-support.js";

const PG_STARTUP_TIMEOUT_MS = 60_000;

describe("pg test-support", () => {
  it("startPg yields a queryable, migrated pool", async () => {
    const { pool, stop } = await startPg();
    try {
      const { rows } = await pool.query("SELECT to_regclass('claims') AS t");
      expect(rows[0].t).toBe("claims");
    } finally {
      await stop();
    }
  }, PG_STARTUP_TIMEOUT_MS);

  it("withPostgres provides a migrated pool and tears down after", async () => {
    let poolAfterTeardown: Pool | undefined;
    await withPostgres(async (pool) => {
      const { rows } = await pool.query("SELECT to_regclass('claims') AS t");
      expect(rows[0].t).toBe("claims");
      poolAfterTeardown = pool;
    });
    // Teardown actually happened: querying the ended pool rejects.
    await expect(poolAfterTeardown!.query("SELECT 1")).rejects.toThrow();
  }, PG_STARTUP_TIMEOUT_MS);

  it("startPg tears down the container if a later setup step throws", async () => {
    const originalStart = PostgreSqlContainer.prototype.start;
    let stopSpy: MockInstance<StartedTestContainer["stop"]> | undefined;
    const startSpy = vi
      .spyOn(PostgreSqlContainer.prototype, "start")
      .mockImplementation(async function (this: PostgreSqlContainer) {
        const started = await originalStart.call(this);
        stopSpy = vi.spyOn(started, "stop");
        return started;
      });
    const connectSpy = vi
      .spyOn(Pool.prototype, "connect")
      .mockRejectedValueOnce(new Error("simulated migration setup failure"));

    try {
      await expect(startPg()).rejects.toThrow("simulated migration setup failure");
      expect(stopSpy).toHaveBeenCalledTimes(1);
    } finally {
      connectSpy.mockRestore();
      startSpy.mockRestore();
    }
  }, PG_STARTUP_TIMEOUT_MS);

  it("startPg's stop() still stops the container even if pool.end() rejects", async () => {
    const originalStart = PostgreSqlContainer.prototype.start;
    let stopSpy: MockInstance<StartedTestContainer["stop"]> | undefined;
    const startSpy = vi
      .spyOn(PostgreSqlContainer.prototype, "start")
      .mockImplementation(async function (this: PostgreSqlContainer) {
        const started = await originalStart.call(this);
        stopSpy = vi.spyOn(started, "stop");
        return started;
      });

    try {
      const { pool, stop } = await startPg();
      // Actually close the pool's connections (so the container isn't torn
      // down out from under a live client) but still surface a rejection to
      // `stop()`, mirroring an `end()` that fails after doing its work.
      const realEnd = pool.end.bind(pool);
      const endSpy = vi.spyOn(pool, "end").mockImplementationOnce(async () => {
        await realEnd();
        throw new Error("simulated end failure");
      });

      await expect(stop()).rejects.toThrow("simulated end failure");
      expect(stopSpy).toHaveBeenCalledTimes(1);

      endSpy.mockRestore();
    } finally {
      startSpy.mockRestore();
    }
  }, PG_STARTUP_TIMEOUT_MS);

  it("sampleClaim returns a minimal valid Claim, overridable", () => {
    const claim = sampleClaim();
    expect(claim.id).toBeTruthy();
    expect(claim.subject).toBeTruthy();
    expect(claim.key).toBeTruthy();
    expect(claim.status).toBe("validated");

    const overridden = sampleClaim({ subject: "project:other", status: "candidate" });
    expect(overridden.subject).toBe("project:other");
    expect(overridden.status).toBe("candidate");
    // Unoverridden fields still populated.
    expect(overridden.key).toBe(claim.key);
  });

  it("sampleClaim rows insert cleanly into a migrated pg claims table", async () => {
    const { pool, stop } = await startPg();
    try {
      const c = sampleClaim();
      await pool.query(
        `INSERT INTO claims (
          id, corpus_id, profile, workspace, subject, key, scope_hash, scope_json,
          value_json, value_hash, conf_distribution, conf_params, conf_raw,
          conf_effective, valid_from, valid_to, recorded, recorded_seq,
          status, source, provenance_json, evidence_json, audience_json, tags_json, schema, run_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
        [
          c.id,
          c.corpusId ?? null,
          c.profile,
          c.workspace,
          c.subject,
          c.key,
          c.scopeHash,
          JSON.stringify(c.scope),
          JSON.stringify(c.value),
          c.valueHash,
          c.confidence.distribution,
          JSON.stringify(c.confidence.parameters),
          c.confidence.raw,
          c.confidence.effective ?? null,
          c.valid.from,
          c.valid.to,
          c.recorded,
          c.recordedSeq,
          c.status,
          c.source,
          JSON.stringify(c.provenance),
          JSON.stringify(c.evidence),
          JSON.stringify(c.audience),
          JSON.stringify(c.tags),
          c.schema,
          c.provenance.runId ?? null,
        ]
      );
      const { rows } = await pool.query("SELECT id FROM claims WHERE id = $1", [c.id]);
      expect(rows[0].id).toBe(c.id);
    } finally {
      await stop();
    }
  }, PG_STARTUP_TIMEOUT_MS);
});
