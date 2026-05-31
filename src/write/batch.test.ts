import { Promoter, type BatchResult } from "./pipeline.js";
import { createSqliteAdapter } from "../adapters/sqlite.js";
import type { ClaimId } from "../core/ids.js";

const baseCandidate = {
  workspace: "w" as any,
  profile: "p" as any,
  subject: "repo",
  key: "repo.x",
  scope: {},
  value: 1,
  confidence: { distribution: "beta" as const, parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
  valid: { start: 0 },
  source: "manual" as const,
  provenance: { traceId: "t1" },
  evidence: [],
  tags: [],
  schema: "v1",
} as any;

const SCHEMA = { scopeFields: {}, scalarPseudocount: {} } as any;

// ======================================================
// §7.5 commit_batch — non-atomic high-throughput
// ======================================================

it("commits a batch of valid claims; all report committed and align with input order", () => {
  const adapter = createSqliteAdapter(":memory:");
  const p = new Promoter(adapter, SCHEMA, "corp");
  const claims = [
    { ...baseCandidate, key: "repo.a", value: 1 },
    { ...baseCandidate, key: "repo.b", value: 2 },
    { ...baseCandidate, key: "repo.c", value: 3 },
  ];

  const batch: BatchResult = p.commitBatch(claims, { policy: { kind: "always_accept" }, writer: "u" });

  expect(batch.results).toHaveLength(3);
  batch.results.forEach((r, i) => {
    expect(r.index).toBe(i);
    expect(r.status).toBe("committed");
    expect(typeof r.id).toBe("string");
  });
  // Every committed claim is retrievable
  for (const r of batch.results) {
    expect(adapter.getClaim(r.id as ClaimId)).toBeDefined();
  }
});

it("one failing write (status error) does NOT abort the rest — non-atomic per spec", () => {
  const adapter = createSqliteAdapter(":memory:");
  const p = new Promoter(adapter, SCHEMA, "corp");
  const claims = [
    { ...baseCandidate, key: "repo.ok1", value: 1 },
    // undeclared scope field → validateScope throws inside commit → status "error"
    { ...baseCandidate, key: "repo.bad", scope: { undeclaredField: "x" }, value: 2 },
    { ...baseCandidate, key: "repo.ok2", value: 3 },
  ];

  const batch = p.commitBatch(claims, { policy: { kind: "always_accept" }, writer: "u" });

  expect(batch.results).toHaveLength(3);
  expect(batch.results[0].status).toBe("committed");
  expect(batch.results[1].status).toBe("error");
  expect(batch.results[1].error).toMatch(/undeclared/i);
  expect(batch.results[1].id).toBeUndefined();
  expect(batch.results[2].status).toBe("committed");
  // The two good claims were persisted despite the middle failure
  expect(adapter.getClaim(batch.results[0].id as ClaimId)).toBeDefined();
  expect(adapter.getClaim(batch.results[2].id as ClaimId)).toBeDefined();
});

it("surfaces per-write rejection status without aborting the batch", () => {
  const adapter = createSqliteAdapter(":memory:");
  const p = new Promoter(adapter, SCHEMA, "corp");
  // Seed a high-confidence claim so a lower-confidence conflicting candidate is rejected.
  p.commit(
    { ...baseCandidate, key: "repo.conflict", value: 99, confidence: { distribution: "beta" as const, parameters: { alpha: 9, beta: 1 }, raw: 0.9 } },
    { policy: { kind: "always_accept" }, writer: "u" }
  );

  const claims = [
    { ...baseCandidate, key: "repo.fresh", value: 7 },
    {
      ...baseCandidate,
      key: "repo.conflict",
      value: 42,
      confidence: { distribution: "beta" as const, parameters: { alpha: 1, beta: 9 }, raw: 0.1 },
    },
  ];

  const batch = p.commitBatch(claims, { policy: { kind: "reject_on_contradiction" }, writer: "u" });

  expect(batch.results[0].status).toBe("committed");
  expect(batch.results[1].status).toBe("rejected");
});

it("surfaces duplicate status via idempotency keys per write", () => {
  const adapter = createSqliteAdapter(":memory:");
  const p = new Promoter(adapter, SCHEMA, "corp");
  // First batch establishes the idempotency record.
  const first = p.commitBatch(
    [{ ...baseCandidate, key: "repo.idem", value: 5, idempotencyKey: "k-1" } as any],
    { policy: { kind: "always_accept" }, writer: "u" }
  );
  expect(first.results[0].status).toBe("committed");

  // Replaying the same idempotencyKey surfaces "duplicate" and no new claim.
  const second = p.commitBatch(
    [{ ...baseCandidate, key: "repo.idem", value: 5, idempotencyKey: "k-1" } as any],
    { policy: { kind: "always_accept" }, writer: "u" }
  );
  expect(second.results[0].status).toBe("duplicate");
  expect(second.results[0].id).toBe(first.results[0].id);
});

it("idempotency is scoped by the enforced corpus, not caller-supplied workspace (no cross-corpus suppression)", () => {
  // Two corpora over one store. A caller pins ONE workspace across both and reuses an
  // idempotency key. Idempotency must key off the enforced corpus boundary — keying off
  // candidate.workspace would suppress corpus B's write as corpus A's "duplicate" and hand
  // back corpus A's claim id (a cross-corpus leak). corpusId is the Promoter's 3rd arg.
  const adapter = createSqliteAdapter(":memory:");
  const pinned = { ...baseCandidate, workspace: "shared" as any, key: "repo.idem" };
  const pA = new Promoter(adapter, SCHEMA, "corpA");
  const pB = new Promoter(adapter, SCHEMA, "corpB");

  const a = pA.commit({ ...pinned, value: 1 }, { policy: { kind: "always_accept" }, writer: "u", idempotencyKey: "shared-key" });
  const b = pB.commit({ ...pinned, value: 2 }, { policy: { kind: "always_accept" }, writer: "u", idempotencyKey: "shared-key" });

  expect(a.status).toBe("committed");
  expect(b.status).toBe("committed"); // NOT "duplicate"
  expect(b.id).not.toBe(a.id);
});

it("stopOnError policy halts the batch after the first error", () => {
  const adapter = createSqliteAdapter(":memory:");
  const p = new Promoter(adapter, SCHEMA, "corp");
  const claims = [
    { ...baseCandidate, key: "repo.first", value: 1 },
    { ...baseCandidate, key: "repo.bad", scope: { undeclaredField: "x" }, value: 2 },
    { ...baseCandidate, key: "repo.never", value: 3 },
  ];

  const batch = p.commitBatch(claims, {
    policy: { kind: "always_accept" },
    writer: "u",
    batchPolicy: { stopOnError: true },
  });

  expect(batch.results).toHaveLength(2); // third never attempted
  expect(batch.results[0].status).toBe("committed");
  expect(batch.results[1].status).toBe("error");
});
