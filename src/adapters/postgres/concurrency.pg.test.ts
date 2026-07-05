import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { startPg } from "./test-support.js";
import { createPostgresAdapter } from "./index.js";
import { dbPerTenantRouter } from "./tenant-router.js";
import { createMnemeAsync } from "../../mneme-async.js";
import type { AsyncStorageAdapter } from "../async-adapter.js";
import type { ClaimEvent } from "../adapter-types.js";
import type { Corpus as CorpusDef } from "../../catalog/corpus.js";
import type { ClaimSchema } from "../../catalog/schema.js";

// ── Real-Postgres concurrency proof for the per-corpus advisory-lock design ──
// These suites drive createMnemeAsync over the async pg adapter under genuine
// parallelism (Promise.all) against ONE testcontainers Postgres, asserting the
// hash-chained audit store never forks, idempotency holds under a race, and
// unrelated corpora don't serialize into failure. NO-PREDICATE router
// (dbPerTenantRouter) — the base schema has no tenant_id column.

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
    workspace: "concurrency-fixture" as any,
    subject: over.subject,
    key: over.key,
    scope: {},
    value: over.value ?? "concurrency value",
    confidence: { distribution: "beta" as const, parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
    valid: { from: 0, to: Infinity },
    source: "manual" as const,
    provenance: {},
    evidence: [],
    tags: [],
    schema: "concurrency@1",
  };
}

// Distinct corpus id per test so the shared DB never bleeds one suite's chain into another's.
let corpusCounter = 0;
function freshCorpusId(): string {
  return `c-conc-${Date.now()}-${corpusCounter++}`;
}

function makeSurface(): { m: ReturnType<typeof createMnemeAsync>; pgAdapter: AsyncStorageAdapter } {
  const pgAdapter = createPostgresAdapter({
    router: dbPerTenantRouter(() => pool),
    tenantId: "t1",
  });
  const m = createMnemeAsync({ adapter: pgAdapter, availableTiers: [{ kind: "core" }] });
  return { m, pgAdapter };
}

/** Assert a corpus's events form one unbroken, recomputable hash chain. */
function assertIntactChain(events: ClaimEvent[]): void {
  expect(events.length).toBeGreaterThan(0);
  expect(events[0].prevHash).toBe("");
  for (let i = 0; i < events.length; i++) {
    if (i > 0) expect(events[i].prevHash).toBe(events[i - 1].entryHash);
    expect(events[i].entryHash).toBe(recompute(events[i]));
  }
}

describe("pg advisory-lock concurrency", () => {
  it(
    "keeps a single unbroken hash chain under 20 parallel same-corpus commits",
    async () => {
      const { m, pgAdapter } = makeSurface();
      const corpus = freshCorpusId();
      m.createCorpus(corpusDefFor(corpus));

      const N = 20;
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          m.commit(corpus, makeCandidate({ subject: `s${i}`, key: `k${i}` }), { writer: "w" })
        )
      );

      // Every distinct-subject/key commit is accepted.
      expect(results.every((r) => r.status === "committed")).toBe(true);
      expect(new Set(results.map((r) => r.id)).size).toBe(N);

      const scoped = pgAdapter.scoped!({ corpus });
      const events = await scoped.readEvents({ corpusId: corpus });

      expect(events).toHaveLength(N);
      assertIntactChain(events);

      // No forked head: recordedSeq is unique within the corpus.
      const seqs = events.map((e) => e.recordedSeq);
      expect(new Set(seqs).size).toBe(N);
    },
    60_000
  );

  it(
    "resolves two concurrent identical-idempotencyKey commits to one id, claim and event",
    async () => {
      const { m, pgAdapter } = makeSurface();
      const corpus = freshCorpusId();
      m.createCorpus(corpusDefFor(corpus));

      const candidate = makeCandidate({ subject: "idem-subject", key: "idem-key" });
      const [r1, r2] = await Promise.all([
        m.commit(corpus, candidate, { writer: "w", idempotencyKey: "k" }),
        m.commit(corpus, candidate, { writer: "w", idempotencyKey: "k" }),
      ]);

      // Both callers observe the SAME committed id.
      expect(r1.id).toBe(r2.id);

      const scoped = pgAdapter.scoped!({ corpus });

      const claims = await scoped.query({ corpusId: corpus, subject: "idem-subject", key: "idem-key" });
      expect(claims).toHaveLength(1);
      expect(claims[0].id).toBe(r1.id);

      const events = await scoped.readEvents({ corpusId: corpus });
      const commits = events.filter((e) => e.op === "commit");
      expect(commits).toHaveLength(1);
      assertIntactChain(events);
    },
    60_000
  );

  it(
    "runs concurrent commits to two different corpora without serializing into failure",
    async () => {
      const { m, pgAdapter } = makeSurface();
      const corpusA = freshCorpusId();
      const corpusB = freshCorpusId();
      m.createCorpus(corpusDefFor(corpusA));
      m.createCorpus(corpusDefFor(corpusB));

      const N = 6;
      const ops: Promise<{ id: string; status: string }>[] = [];
      // Interleave writes across the two corpora so the per-corpus locks are
      // exercised concurrently; unrelated corpora must not block each other.
      for (let i = 0; i < N; i++) {
        ops.push(m.commit(corpusA, makeCandidate({ subject: `a${i}`, key: `ka${i}` }), { writer: "w" }));
        ops.push(m.commit(corpusB, makeCandidate({ subject: `b${i}`, key: `kb${i}` }), { writer: "w" }));
      }
      const results = await Promise.all(ops);
      expect(results.every((r) => r.status === "committed")).toBe(true);

      const scopedA = pgAdapter.scoped!({ corpus: corpusA });
      const scopedB = pgAdapter.scoped!({ corpus: corpusB });
      const eventsA = await scopedA.readEvents({ corpusId: corpusA });
      const eventsB = await scopedB.readEvents({ corpusId: corpusB });

      expect(eventsA).toHaveLength(N);
      expect(eventsB).toHaveLength(N);
      assertIntactChain(eventsA);
      assertIntactChain(eventsB);
    },
    60_000
  );
});
