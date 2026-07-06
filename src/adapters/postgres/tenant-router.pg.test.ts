// Docker-only (gated by the `.pg.test.ts` suffix -> `npm run test:pg`).
//
// rowLevelRouter now exposes the resolved tenant VALUE (`tenantId`); the
// adapter stamps/filters it as the base schema's `tenant_id` column (added by
// Migration v2). End-to-end row-level isolation against the REAL tables is
// proven in row-level.pg.test.ts -- these are the pure routing-contract tests.
import { describe, it, expect, vi } from "vitest";
import { Pool } from "pg";
import {
  rowLevelRouter,
  schemaPerTenantRouter,
  dbPerTenantRouter,
} from "./tenant-router.js";

describe("rowLevelRouter", () => {
  it("exposes the resolved tenant VALUE as tenantId, with empty schemaPrefix", () => {
    const pool = new Pool();
    const router = rowLevelRouter(pool);
    const resolved = router.resolve("acme");
    expect(resolved.schemaPrefix).toBe("");
    expect(resolved.tenantId).toBe("acme");
    return pool.end();
  });

  it("throws on empty/blank tenantId", async () => {
    const pool = new Pool();
    const router = rowLevelRouter(pool);
    expect(() => router.resolve("")).toThrow();
    expect(() => router.resolve("   ")).toThrow();
    await pool.end();
  });

  it("resolves any non-blank id (row-level accepts any tenant string)", async () => {
    const pool = new Pool();
    const router = rowLevelRouter(pool);
    const resolved = router.resolve("some-tenant");
    expect(resolved.tenantId).toBe("some-tenant");
    await pool.end();
  });
});

describe("schemaPerTenantRouter", () => {
  it("resolves a known tenant to a validated schema prefix", () => {
    const pool = new Pool();
    const schemaFor = (t: string) => ({ acme: "tenant_acme" }[t] ?? "");
    const router = schemaPerTenantRouter(pool, schemaFor);
    const resolved = router.resolve("acme");
    expect(resolved.schemaPrefix).toBe("tenant_acme.");
    expect(resolved.tenantId).toBeUndefined();
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
    expect(resolvedA.tenantId).toBeUndefined();
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
