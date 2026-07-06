import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { startPg } from "./test-support.js";
import { createPostgresAdapter } from "./index.js";
import { rowLevelRouter } from "./tenant-router.js";
import { createMnemeAsync } from "../../mneme-async.js";
import type { AsyncStorageAdapter } from "../async-adapter.js";
import type { ClaimEvent } from "../adapter-types.js";
import type { Corpus as CorpusDef } from "../../catalog/corpus.js";
import type { ClaimSchema } from "../../catalog/schema.js";

// ── Real-Postgres row-level multi-tenancy proof ──────────────────────────────
// Two async surfaces over ONE pool, SAME corpus name "default", DIFFERENT
// tenants (rowLevelRouter). Migration v2's `tenant_id` column must isolate
// claims, PARTITION the hash chain per (tenant, corpus), and isolate
// idempotency -- all against the shared base tables.

let pool: Pool;
let stop: () => Promise<void>;

beforeAll(async () => {
  const pg = await startPg();
  pool = pg.pool;
  stop = pg.stop;
}, 180_000);

afterAll(async () => {
  await stop?.();
});

/** Byte-exact mirror of index.ts's canonicalEvent (field order is load-bearing). */
function canonicalEvent(e: ClaimEvent): string {
  return JSON.stringify([
    e.op,
    e.corpusId,
    e.writer,
    e.claimId,
    e.deprecatedId ?? null,
    e.toStatus ?? null,
    e.reason ?? null,
    e.recorded,
    e.recordedSeq,
  ]);
}

/** Recompute the audit-store hash the same way appendEvent does. */
function recompute(e: ClaimEvent): string {
  return createHash("sha256")
    .update(canonicalEvent(e) + (e.prevHash ?? ""))
    .digest("hex");
}

/** Assert a tenant's events form one unbroken, recomputable hash chain. */
function assertIntactChain(events: ClaimEvent[]): void {
  expect(events.length).toBeGreaterThan(0);
  expect(events[0].prevHash).toBe("");
  for (let i = 0; i < events.length; i++) {
    if (i > 0) expect(events[i].prevHash).toBe(events[i - 1].entryHash);
    expect(events[i].entryHash).toBe(recompute(events[i]));
  }
}

function schemaFor(id: string): ClaimSchema {
  return {
    version: "1",
    subjects: [id],
    scopeFields: {},
    required: [],
    scalarPseudocount: { manual: 2 },
  };
}

function corpusDefFor(id: string): CorpusDef {
  return {
    id,
    displayName: id,
    schema: schemaFor(id),
    defaults: {
      decayPolicy: { kind: "none" },
      confidenceThreshold: 0.5,
      contradictionPolicy: { kind: "always_accept" },
      defaultStatus: ["validated"],
    },
    requiredTiers: [{ kind: "core" }],
    metadata: {},
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeCandidate(over: { subject: string; key: string; value?: string }) {
  return {
    profile: "profile-1" as any,
    workspace: "row-level-fixture" as any,
    subject: over.subject,
    key: over.key,
    scope: {},
    value: over.value ?? "row-level value",
    confidence: { distribution: "beta" as const, parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
    valid: { from: 0, to: Infinity },
    source: "manual" as const,
    provenance: {},
    evidence: [],
    tags: [],
    schema: "row-level@1",
  };
}

function makeSurface(tenantId: string): {
  m: ReturnType<typeof createMnemeAsync>;
  pgAdapter: AsyncStorageAdapter;
} {
  const pgAdapter = createPostgresAdapter({
    router: rowLevelRouter(pool),
    tenantId,
  });
  const m = createMnemeAsync({ adapter: pgAdapter, availableTiers: [{ kind: "core" }] });
  return { m, pgAdapter };
}

const CORPUS = "default";

// All three `it` blocks share ONE pool (beforeAll) and the SAME literal
// corpus name "default" -- so distinct tenant ids per test are required to
// keep each test's claims/events from bleeding into the next (a real tenant
// value, not a test-isolation hack: it exercises the exact same row-level
// partitioning the suite is proving).
let tenantSuffix = 0;
function freshTenantPair(): { a: string; b: string } {
  tenantSuffix += 1;
  return { a: `tenantA-${tenantSuffix}`, b: `tenantB-${tenantSuffix}` };
}

describe("pg row-level multi-tenancy", () => {
  it(
    "isolates claims for two tenants sharing corpus 'default' under the same (subject,key)",
    async () => {
      const { a, b } = freshTenantPair();
      const { m: mA } = makeSurface(a);
      const { m: mB } = makeSurface(b);
      mA.createCorpus(corpusDefFor(CORPUS));
      mB.createCorpus(corpusDefFor(CORPUS));

      const rA = await mA.commit(
        CORPUS,
        makeCandidate({ subject: "shared-subject", key: "shared-key", value: "A-value" }),
        { writer: "wA" }
      );
      const rB = await mB.commit(
        CORPUS,
        makeCandidate({ subject: "shared-subject", key: "shared-key", value: "B-value" }),
        { writer: "wB" }
      );
      expect(rA.status).toBe("committed");
      expect(rB.status).toBe("committed");
      expect(rA.id).not.toBe(rB.id);

      const aClaims = await mA.read(CORPUS, {
        corpusId: CORPUS,
        subject: "shared-subject",
        key: "shared-key",
      });
      const bClaims = await mB.read(CORPUS, {
        corpusId: CORPUS,
        subject: "shared-subject",
        key: "shared-key",
      });

      // Each tenant sees ONLY its own claim -- never the other's.
      expect(aClaims.map((c) => c.id)).toEqual([rA.id]);
      expect(aClaims.map((c) => c.value)).toEqual(["A-value"]);
      expect(bClaims.map((c) => c.id)).toEqual([rB.id]);
      expect(bClaims.map((c) => c.value)).toEqual(["B-value"]);
    },
    120_000
  );

  it(
    "partitions the hash chain per (tenant, corpus): interleaved commits never fork one chain",
    async () => {
      const { a, b } = freshTenantPair();
      const { m: mA, pgAdapter: pgA } = makeSurface(a);
      const { m: mB, pgAdapter: pgB } = makeSurface(b);
      mA.createCorpus(corpusDefFor(CORPUS));
      mB.createCorpus(corpusDefFor(CORPUS));

      const N = 5;
      // Interleave A and B commits to the SAME corpus name "default".
      for (let i = 0; i < N; i++) {
        await mA.commit(CORPUS, makeCandidate({ subject: `a${i}`, key: `ka${i}` }), { writer: "wA" });
        await mB.commit(CORPUS, makeCandidate({ subject: `b${i}`, key: `kb${i}` }), { writer: "wB" });
      }

      const eventsA = await pgA.scoped!({ corpus: CORPUS }).readEvents({ corpusId: CORPUS });
      const eventsB = await pgB.scoped!({ corpus: CORPUS }).readEvents({ corpusId: CORPUS });

      // Each tenant sees exactly its own N events -- not the other's, not a merge.
      expect(eventsA).toHaveLength(N);
      expect(eventsB).toHaveLength(N);

      // Each tenant's events form ONE unbroken hash chain (they did not
      // interleave into a single shared "default" chain).
      assertIntactChain(eventsA);
      assertIntactChain(eventsB);
    },
    120_000
  );

  it(
    "isolates idempotency: same idempotencyKey across tenants does NOT suppress the second write",
    async () => {
      const { a, b } = freshTenantPair();
      const { m: mA, pgAdapter: pgA } = makeSurface(a);
      const { m: mB, pgAdapter: pgB } = makeSurface(b);
      mA.createCorpus(corpusDefFor(CORPUS));
      mB.createCorpus(corpusDefFor(CORPUS));

      const candA = makeCandidate({ subject: "idem-subject", key: "idem-key", value: "A" });
      const candB = makeCandidate({ subject: "idem-subject", key: "idem-key", value: "B" });

      const rA = await mA.commit(CORPUS, candA, { writer: "wA", idempotencyKey: "shared-key" });
      const rB = await mB.commit(CORPUS, candB, { writer: "wB", idempotencyKey: "shared-key" });

      // B's write is NOT suppressed as A's "duplicate".
      expect(rA.status).toBe("committed");
      expect(rB.status).toBe("committed");
      expect(rA.id).not.toBe(rB.id);

      const scopedA = pgA.scoped!({ corpus: CORPUS });
      const scopedB = pgB.scoped!({ corpus: CORPUS });

      const aClaims = await scopedA.query({ corpusId: CORPUS, subject: "idem-subject", key: "idem-key" });
      const bClaims = await scopedB.query({ corpusId: CORPUS, subject: "idem-subject", key: "idem-key" });
      expect(aClaims.map((c) => c.id)).toEqual([rA.id]);
      expect(bClaims.map((c) => c.id)).toEqual([rB.id]);

      // Each tenant/corpus ends with exactly one commit event for it.
      const aCommits = (await scopedA.readEvents({ corpusId: CORPUS })).filter((e) => e.op === "commit");
      const bCommits = (await scopedB.readEvents({ corpusId: CORPUS })).filter((e) => e.op === "commit");
      expect(aCommits).toHaveLength(1);
      expect(bCommits).toHaveLength(1);
    },
    120_000
  );
});
