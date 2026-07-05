// Docker-only (gated by the `.pg.test.ts` suffix -> `npm run test:pg`).
//
// The rowLevel-isolation test proves the injected `tenantPredicate` actually
// isolates rows end-to-end against a real Postgres, using an AD-HOC table
// (`t_iso`) because the base `MIGRATIONS` claims schema has no `tenant_id`
// column -- see the caveat documented at the top of tenant-router.ts.
import { describe, it, expect, vi } from "vitest";
import { Pool } from "pg";
import { startPg } from "./test-support.js";
import {
  rowLevelRouter,
  schemaPerTenantRouter,
  dbPerTenantRouter,
} from "./tenant-router.js";

describe("rowLevelRouter", () => {
  it("isolates rows end-to-end via the injected tenantPredicate", async () => {
    const { pool, stop } = await startPg();
    try {
      const setup = await pool.connect();
      try {
        await setup.query("CREATE TABLE t_iso (tenant_id text, v text)");
        await setup.query(
          "INSERT INTO t_iso (tenant_id, v) VALUES ($1, $2), ($3, $4), ($5, $6)",
          ["A", "a1", "A", "a2", "B", "b1"]
        );
      } finally {
        setup.release();
      }

      const router = rowLevelRouter(pool);
      const resolved = router.resolve("B");
      expect(resolved.schemaPrefix).toBe("");
      expect(resolved.tenantPredicate).toBeDefined();

      // Renumber the caller-supplied `$` marker to `$1`, matching how
      // sql.ts's buildQuery consumes tenantPredicate.
      const sql = resolved.tenantPredicate!.sql.replace("$", "$1");
      const client = await resolved.connect();
      try {
        const { rows } = await client.query(
          `SELECT v FROM t_iso WHERE ${sql}`,
          resolved.tenantPredicate!.params
        );
        expect(rows.map((r) => r.v).sort()).toEqual(["b1"]);
      } finally {
        client.release();
        await setup_drop(pool);
      }
    } finally {
      await stop();
    }
  }, 60_000);

  it("throws on empty/blank tenantId", async () => {
    const pool = new Pool();
    const router = rowLevelRouter(pool);
    expect(() => router.resolve("")).toThrow();
    expect(() => router.resolve("   ")).toThrow();
    await pool.end();
  });

  it("throws on unknown tenant handling is not applicable (row-level accepts any non-blank id) -- sanity: valid id resolves", async () => {
    const pool = new Pool();
    const router = rowLevelRouter(pool);
    const resolved = router.resolve("some-tenant");
    expect(resolved.tenantPredicate).toEqual({
      sql: "tenant_id = $",
      params: ["some-tenant"],
    });
    await pool.end();
  });
});

async function setup_drop(pool: Pool): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("DROP TABLE IF EXISTS t_iso");
  } finally {
    c.release();
  }
}

describe("schemaPerTenantRouter", () => {
  it("resolves a known tenant to a validated schema prefix", () => {
    const pool = new Pool();
    const schemaFor = (t: string) => ({ acme: "tenant_acme" }[t] ?? "");
    const router = schemaPerTenantRouter(pool, schemaFor);
    const resolved = router.resolve("acme");
    expect(resolved.schemaPrefix).toBe("tenant_acme.");
    expect(resolved.tenantPredicate).toBeUndefined();
    return pool.end();
  });

  it("throws on unmapped tenant", async () => {
    const pool = new Pool();
    const schemaFor = (t: string) => ({ acme: "tenant_acme" }[t] ?? "");
    const router = schemaPerTenantRouter(pool, schemaFor);
    expect(() => router.resolve("intruder")).toThrow(/invalid|unknown/i);
    await pool.end();
  });

  it("throws on a raw-injection schema name rather than interpolating it", async () => {
    const pool = new Pool();
    const schemaFor = (_t: string) => "x; DROP";
    const router = schemaPerTenantRouter(pool, schemaFor);
    expect(() => router.resolve("anything")).toThrow(/invalid|unknown/i);
    await pool.end();
  });

  it("never calls SET search_path", () => {
    const pool = new Pool();
    const querySpy = vi.spyOn(pool, "connect");
    const schemaFor = (t: string) => ({ acme: "tenant_acme" }[t] ?? "");
    const router = schemaPerTenantRouter(pool, schemaFor);
    const resolved = router.resolve("acme");
    expect(resolved.schemaPrefix).toBe("tenant_acme.");
    // connect() itself is the only path to a client; we never issue a
    // SET search_path query as part of resolve().
    expect(querySpy).not.toHaveBeenCalled();
    querySpy.mockRestore();
    return pool.end();
  });
});

describe("dbPerTenantRouter", () => {
  it("routes each tenant to the pool poolFor returns, with empty prefix", async () => {
    const poolA = new Pool();
    const poolB = new Pool();
    const calls: string[] = [];
    const poolFor = vi.fn((t: string) => {
      calls.push(t);
      return t === "a" ? poolA : poolB;
    });
    const router = dbPerTenantRouter(poolFor);

    const connectASpy = vi
      .spyOn(poolA, "connect")
      .mockResolvedValue({} as never);
    const resolvedA = router.resolve("a");
    expect(resolvedA.schemaPrefix).toBe("");
    expect(resolvedA.tenantPredicate).toBeUndefined();
    await resolvedA.connect();
    expect(connectASpy).toHaveBeenCalledTimes(1);

    const connectBSpy = vi
      .spyOn(poolB, "connect")
      .mockResolvedValue({} as never);
    const resolvedB = router.resolve("b");
    await resolvedB.connect();
    expect(connectBSpy).toHaveBeenCalledTimes(1);
    expect(connectASpy).toHaveBeenCalledTimes(1); // still just once: didn't route to A

    expect(poolFor).toHaveBeenCalledWith("a");
    expect(poolFor).toHaveBeenCalledWith("b");

    connectASpy.mockRestore();
    connectBSpy.mockRestore();
    await router.closeAll();
  });

  it("closeAll ends every distinct pool handed out", async () => {
    const poolA = new Pool();
    const poolB = new Pool();
    const poolFor = (t: string) => (t === "a" ? poolA : poolB);
    const router = dbPerTenantRouter(poolFor);

    router.resolve("a");
    router.resolve("b");
    router.resolve("a"); // repeat tenant: same pool, should not double-close

    const endASpy = vi.spyOn(poolA, "end");
    const endBSpy = vi.spyOn(poolB, "end");

    await router.closeAll();

    expect(endASpy).toHaveBeenCalledTimes(1);
    expect(endBSpy).toHaveBeenCalledTimes(1);
  });

  it("throws when poolFor throws for an unknown tenant", async () => {
    const poolFor = (t: string) => {
      if (t !== "known") throw new Error("unknown tenant");
      return new Pool();
    };
    const router = dbPerTenantRouter(poolFor);
    expect(() => router.resolve("unknown")).toThrow(/unknown tenant/);
  });
});
