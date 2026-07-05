import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Pool } from "pg";
import { startPg, sampleClaim } from "./test-support.js";
import { createPostgresAdapter } from "./index.js";
import { dbPerTenantRouter } from "./tenant-router.js";
import type { ClaimEvent } from "../adapter-types.js";
import type { ClaimId } from "../../core/ids.js";
import { createHash } from "node:crypto";

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

function makeAdapter() {
  return createPostgresAdapter({
    router: dbPerTenantRouter(() => pool),
    tenantId: "t1",
  });
}

describe("createPostgresAdapter", () => {
  it("round-trips a committed claim through insert -> query and getClaim", async () => {
    const adapter = makeAdapter();
    const scoped = adapter.scoped!({ corpus: "c-rt" });
    const claim = sampleClaim({ subject: "project:rt", key: "rt.key" });

    await scoped.transaction("c-rt", async () => {
      await scoped.insertClaim(claim);
    });

    const rows = await scoped.query({ corpusId: "c-rt", subject: "project:rt" });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(claim.id);

    // Byte-exact round-trip through getClaim (corpus_id stamped by scope).
    const got = await scoped.getClaim(claim.id);
    expect(got).toEqual({ ...claim, corpusId: "c-rt" });
  });

  it("hides a base (unscoped) row from a differently-scoped getClaim", async () => {
    const adapter = makeAdapter();
    const claim = sampleClaim({ subject: "project:scope" });

    await adapter.transaction("c-base", async () => {
      await adapter.insertClaim(claim);
    });

    // Base adapter sees it (corpus_id is NULL).
    expect((await adapter.getClaim(claim.id))?.id).toBe(claim.id);

    // A scope bound to a different corpus cannot see it.
    const other = adapter.scoped!({ corpus: "c-other" });
    expect(await other.getClaim(claim.id)).toBeUndefined();
  });

  it("chains appendEvent entryHash from the previous prevHash", async () => {
    const adapter = makeAdapter();
    const e1: ClaimEvent = {
      op: "commit",
      corpusId: "c-ev",
      writer: "w1",
      claimId: "claim-a",
      recorded: 0,
      recordedSeq: 1,
    };
    const e2: ClaimEvent = { ...e1, claimId: "claim-b", recordedSeq: 2 };

    await adapter.transaction("c-ev", async () => {
      await adapter.appendEvent(e1);
      await adapter.appendEvent(e2);
    });

    const events = await adapter.readEvents({ corpusId: "c-ev" });
    expect(events).toHaveLength(2);
    // Genesis event has an empty prevHash.
    expect(events[0].prevHash).toBe("");
    expect(events[0].entryHash).toBeTruthy();
    // Second event chains from the first's entryHash.
    expect(events[1].prevHash).toBe(events[0].entryHash);

    // The chain is a real sha256 over canonical(event) + prevHash.
    const canonical = JSON.stringify([
      e1.op,
      e1.corpusId,
      e1.writer,
      e1.claimId,
      null,
      null,
      null,
      e1.recorded,
      e1.recordedSeq,
    ]);
    const expectedFirst = createHash("sha256").update(canonical + "").digest("hex");
    expect(events[0].entryHash).toBe(expectedFirst);
  });

  it("scopes maxRecordedSeq to the given corpus", async () => {
    const adapter = makeAdapter();
    const sa = adapter.scoped!({ corpus: "c-max-a" });
    const sb = adapter.scoped!({ corpus: "c-max-b" });

    await sa.transaction("c-max-a", async () => {
      await sa.insertClaim(sampleClaim({ subject: "project:maxa", recordedSeq: 5 }));
    });
    await sb.transaction("c-max-b", async () => {
      await sb.insertClaim(sampleClaim({ subject: "project:maxb", recordedSeq: 9 }));
    });

    expect(await adapter.maxRecordedSeq("c-max-a")).toBe(5);
    expect(await adapter.maxRecordedSeq("c-max-b")).toBe(9);
  });

  it("get/put idempotency records", async () => {
    const adapter = makeAdapter();
    expect(await adapter.getIdempotencyRecord("s1", "k1")).toBeUndefined();

    await adapter.putIdempotencyRecord("s1", "k1", { result: "r1", createdAt: 123 });
    const rec = await adapter.getIdempotencyRecord("s1", "k1");
    expect(rec).toEqual({ result: "r1", createdAt: 123 });
  });

  it("rolls back the whole transaction when the body throws", async () => {
    const adapter = makeAdapter();
    const scoped = adapter.scoped!({ corpus: "c-rb" });
    const claim = sampleClaim({ subject: "project:rb" });

    await expect(
      scoped.transaction("c-rb", async () => {
        await scoped.insertClaim(claim);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const rows = await scoped.query({ corpusId: "c-rb", subject: "project:rb" });
    expect(rows).toHaveLength(0);
  });

  it("rolls back an entire standalone base insertBatch when a row fails mid-batch", async () => {
    const adapter = makeAdapter();
    // First row is valid; the second carries a non-numeric recorded_seq that
    // the `bigint` column rejects, forcing a mid-batch throw. There is no
    // ambient transaction() here, so atomicity must come from insertBatch.
    const good = sampleClaim({
      id: "batch-atomic-base" as ClaimId,
      subject: "project:batch-base",
    });
    const bad = sampleClaim({
      id: "batch-atomic-base-bad" as ClaimId,
      subject: "project:batch-base",
      recordedSeq: "not-a-bigint" as unknown as number,
    });

    await expect(adapter.insertBatch([good, bad])).rejects.toThrow();

    // Self-atomic: the first (valid) row must NOT have been committed.
    expect(await adapter.getClaim("batch-atomic-base" as ClaimId)).toBeUndefined();
  });

  it("rolls back an entire standalone scoped insertBatch when a row fails mid-batch", async () => {
    const adapter = makeAdapter();
    const scoped = adapter.scoped!({ corpus: "c-batch-atomic" });
    const good = sampleClaim({
      id: "batch-atomic-scoped" as ClaimId,
      subject: "project:batch-scoped",
    });
    const bad = sampleClaim({
      id: "batch-atomic-scoped-bad" as ClaimId,
      subject: "project:batch-scoped",
      recordedSeq: "not-a-bigint" as unknown as number,
    });

    await expect(scoped.insertBatch([good, bad])).rejects.toThrow();

    // Self-atomic (via the per-corpus transaction path): nothing persisted.
    expect(await scoped.getClaim("batch-atomic-scoped" as ClaimId)).toBeUndefined();
    const rows = await scoped.query({ corpusId: "c-batch-atomic", subject: "project:batch-scoped" });
    expect(rows).toHaveLength(0);
  });

  it("reports all value predicates as fallback_in_memory", () => {
    const caps = makeAdapter().capabilities();
    for (const level of Object.values(caps.valuePredicateSupport)) {
      expect(level).toBe("fallback_in_memory");
    }
  });
});
