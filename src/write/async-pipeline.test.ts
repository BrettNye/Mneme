import { AsyncPromoter } from "./async-pipeline.js";
import type { AsyncStorageAdapter } from "../adapters/async-adapter.js";
import type { ExecutionPlan, IdempotencyRecord, ClaimEvent } from "../adapters/adapter.js";
import type { Claim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";

type FakeAsyncAdapter = AsyncStorageAdapter & {
  inserted: Claim[];
  deleted: ClaimId[];
  events: ClaimEvent[];
};

function fakeAsyncAdapter(preloaded: Claim[] = []): FakeAsyncAdapter {
  const store: Claim[] = [...preloaded];
  const inserted: Claim[] = [];
  const deleted: ClaimId[] = [];
  const events: ClaimEvent[] = [];
  const idempotencyStore = new Map<string, IdempotencyRecord>();

  const matchCorpus = (c: Claim, corpusId: string): boolean =>
    corpusId === "" ? true : c.corpusId === (corpusId as unknown as Claim["corpusId"]);

  return {
    inserted,
    deleted,
    events,
    async query(plan: ExecutionPlan): Promise<Claim[]> {
      return store.filter(
        (c) =>
          matchCorpus(c, plan.corpusId) &&
          (!plan.subject || c.subject === plan.subject) &&
          (!plan.key || c.key === plan.key) &&
          (!plan.scopeHash || c.scopeHash === plan.scopeHash) &&
          (!plan.status || plan.status.includes(c.status))
      );
    },
    async insertClaim(c: Claim): Promise<void> {
      store.push(c);
      inserted.push(c);
    },
    async deleteClaim(id: ClaimId): Promise<void> {
      const idx = store.findIndex((c) => c.id === id);
      if (idx !== -1) store.splice(idx, 1);
      deleted.push(id);
    },
    async getClaim(id: ClaimId): Promise<Claim | undefined> {
      return store.find((c) => c.id === id);
    },
    async insertBatch(): Promise<void> {},
    async getIdempotencyRecord(scope: string, key: string): Promise<IdempotencyRecord | undefined> {
      return idempotencyStore.get(`${scope}::${key}`);
    },
    async putIdempotencyRecord(scope: string, key: string, rec: IdempotencyRecord): Promise<void> {
      idempotencyStore.set(`${scope}::${key}`, rec);
    },
    capabilities() {
      return {
        valuePredicateSupport: {
          equality: "fallback_in_memory",
          range: "fallback_in_memory",
          set_membership: "fallback_in_memory",
          regex: "fallback_in_memory",
          structural_pattern: "fallback_in_memory",
          null_check: "fallback_in_memory",
        },
      };
    },
    async transaction<T>(_corpusId: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async maxRecordedSeq(corpusId: string): Promise<number> {
      const scoped = store.filter((c) => matchCorpus(c, corpusId));
      if (scoped.length === 0) return -1;
      return Math.max(...scoped.map((c) => c.recordedSeq));
    },
    async appendEvent(e: ClaimEvent): Promise<void> {
      events.push(e);
    },
    async readEvents(filter?: { corpusId?: string; claimId?: string; since?: number }): Promise<ClaimEvent[]> {
      return events.filter((e) => !filter?.corpusId || e.corpusId === filter.corpusId);
    },
  } as FakeAsyncAdapter;
}

const schema = { scopeFields: {}, scalarPseudocount: {} } as any;

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

// ======================================================
// commit
// ======================================================

it("commit inserts a claim, appends one event, and returns committed", async () => {
  const a = fakeAsyncAdapter();
  const p = new AsyncPromoter(a, schema, "c1", () => 1000);
  const r = await p.commit(baseCandidate, { policy: { kind: "always_accept" }, writer: "w" });
  expect(r.status).toBe("committed");
  expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(a.inserted).toHaveLength(1);
  expect(a.inserted[0].id).toBe(r.id);
  expect(a.inserted[0].corpusId).toBe("c1");
  expect(a.inserted[0].recorded).toBe(1000);
  expect((await a.readEvents({ corpusId: "c1" })).length).toBe(1);
});

it("commit derives recordedSeq from maxRecordedSeq()+1 (corpus-scoped)", async () => {
  const a = fakeAsyncAdapter();
  const p = new AsyncPromoter(a, schema, "c1", () => 1000);
  await p.commit(baseCandidate, { policy: { kind: "always_accept" }, writer: "w" });
  await p.commit({ ...baseCandidate, key: "repo.y" }, { policy: { kind: "always_accept" }, writer: "w" });
  expect(a.inserted[0].recordedSeq).toBe(0);
  expect(a.inserted[1].recordedSeq).toBe(1);
});

it("commit returns duplicate for a repeated idempotencyKey and writes exactly one event", async () => {
  const a = fakeAsyncAdapter();
  const p = new AsyncPromoter(a, schema, "c1", () => 1000);
  const r1 = await p.commit(baseCandidate, { policy: { kind: "always_accept" }, writer: "w", idempotencyKey: "k1" });
  const r2 = await p.commit(baseCandidate, { policy: { kind: "always_accept" }, writer: "w", idempotencyKey: "k1" });
  expect(r2).toEqual({ id: r1.id, status: "duplicate" });
  expect(a.inserted).toHaveLength(1);
  expect((await a.readEvents({ corpusId: "c1" })).length).toBe(1);
});

it("commit validateScope throws on undeclared scope field and inserts nothing", async () => {
  const a = fakeAsyncAdapter();
  const p = new AsyncPromoter(a, schema, "c1", () => 1000);
  await expect(
    p.commit({ ...baseCandidate, scope: { undeclaredField: "x" } }, { policy: { kind: "always_accept" }, writer: "w" })
  ).rejects.toThrow(/undeclared/i);
  expect(a.inserted).toHaveLength(0);
});

it("commit returns rejected and inserts nothing under reject_on_contradiction", async () => {
  const existing: Claim = {
    ...baseCandidate,
    id: "existing-id" as any,
    scopeHash: "_",
    valueHash: "deadbeef1234abcd",
    value: 99,
    recorded: 1,
    recordedSeq: 0,
    status: "validated",
    corpusId: "c1" as any,
    confidence: { distribution: "beta" as const, parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
  };
  const a = fakeAsyncAdapter([existing]);
  const p = new AsyncPromoter(a, schema, "c1", () => 1000);
  const r = await p.commit(
    { ...baseCandidate, value: 42, confidence: { distribution: "beta" as const, parameters: { alpha: 1, beta: 9 }, raw: 0.1 } },
    { policy: { kind: "reject_on_contradiction" }, writer: "w" }
  );
  expect(r.status).toBe("rejected");
  expect(a.inserted).toHaveLength(0);
  expect((await a.readEvents({ corpusId: "c1" })).length).toBe(0);
});

it("commit accept_and_resolve deprecates the lower-confidence loser before insert", async () => {
  const existing: Claim = {
    ...baseCandidate,
    id: "loser-id" as any,
    scopeHash: "_",
    valueHash: "deadbeef1234abcd",
    value: 99,
    recorded: 1,
    recordedSeq: 0,
    status: "validated",
    corpusId: "c1" as any,
    confidence: { distribution: "beta" as const, parameters: { alpha: 1, beta: 9 }, raw: 0.1 },
  };
  const a = fakeAsyncAdapter([existing]);
  const p = new AsyncPromoter(a, schema, "c1", () => 1000);
  const r = await p.commit(
    { ...baseCandidate, value: 42, confidence: { distribution: "beta" as const, parameters: { alpha: 9, beta: 1 }, raw: 0.9 } },
    { policy: { kind: "accept_and_resolve", rule: "deprecate_lower" }, writer: "w" }
  );
  expect(r.status).toBe("committed");
  expect(a.deleted).toContain("loser-id");
  expect(a.inserted).toHaveLength(1);
});

it("commit accept_but_mark writes a queryable contradiction artifact plus the accepted claim", async () => {
  const existing: Claim = {
    ...baseCandidate,
    id: "claim-A" as any,
    scopeHash: "_",
    valueHash: "vh-existing",
    value: 1,
    recorded: 1,
    recordedSeq: 0,
    status: "validated",
    corpusId: "c1" as any,
  } as unknown as Claim;
  const a = fakeAsyncAdapter([existing]);
  const p = new AsyncPromoter(a, schema, "c1", () => 1000);
  const r = await p.commit({ ...baseCandidate, value: 2 }, { policy: { kind: "accept_but_mark" }, writer: "w" });
  expect(r.status).toBe("committed");
  const artifacts = a.inserted.filter((c) => c.subject === ("contradiction" as any));
  expect(artifacts).toHaveLength(1);
  expect(artifacts[0].value).toEqual({ leftId: r.id, rightId: "claim-A" });
  expect(a.inserted.filter((c) => c.subject === ("repo" as any))).toHaveLength(1);
});

// ======================================================
// commitBatch
// ======================================================

it("commitBatch returns per-item statuses in input order", async () => {
  const a = fakeAsyncAdapter();
  const p = new AsyncPromoter(a, schema, "c1", () => 1000);
  const res = await p.commitBatch(
    [
      { ...baseCandidate, key: "repo.a" },
      { ...baseCandidate, key: "repo.b" },
    ],
    { policy: { kind: "always_accept" }, writer: "w" }
  );
  expect(res.results.map((r) => r.status)).toEqual(["committed", "committed"]);
  expect(res.results.map((r) => r.index)).toEqual([0, 1]);
  expect(a.inserted).toHaveLength(2);
});

// ======================================================
// supersede
// ======================================================

it("supersede inserts a fresh replacement, deletes the deprecated id, and logs a supersede event", async () => {
  const a = fakeAsyncAdapter();
  const p = new AsyncPromoter(a, schema, "corp", () => 1000);
  const r = await p.supersede("old-id" as ClaimId, { ...baseCandidate, value: 99 }, { writer: "alice" });
  expect(r.status).toBe("superseded");
  expect(r.id).not.toBe("old-id");
  expect(a.deleted).toContain("old-id");
  const newClaim = a.inserted.find((c) => c.id === r.id);
  expect(newClaim!.value).toBe(99);
  const ev = a.events.filter((e) => e.op === "supersede");
  expect(ev).toHaveLength(1);
  expect(ev[0].deprecatedId).toBe("old-id");
  expect(ev[0].claimId).toBe(r.id);
});

it("supersede idempotency: second call with same key returns duplicate, one insert", async () => {
  const a = fakeAsyncAdapter();
  const p = new AsyncPromoter(a, schema, "c1", () => 1000);
  const r1 = await p.supersede("dep-id" as ClaimId, baseCandidate, { writer: "u", idempotencyKey: "sup-key" });
  const r2 = await p.supersede("dep-id" as ClaimId, baseCandidate, { writer: "u", idempotencyKey: "sup-key" });
  expect(r1.status).toBe("superseded");
  expect(r2).toEqual({ id: r1.id, status: "duplicate" });
  expect(a.inserted.filter((c) => c.id === r1.id)).toHaveLength(1);
});

// ======================================================
// promote
// ======================================================

it("promote candidate->validated succeeds in place, keeps recorded/recordedSeq", async () => {
  const target: Claim = {
    ...baseCandidate,
    id: "claim-1" as any,
    scopeHash: "_",
    valueHash: "abcdef1234567890",
    recorded: 2000,
    recordedSeq: 3,
    status: "candidate",
    corpusId: "c1" as any,
  };
  const a = fakeAsyncAdapter([target]);
  const p = new AsyncPromoter(a, schema, "c1", () => 5000);
  const r = await p.promote("claim-1" as ClaimId, "validated", { writer: "u", reason: "passed" });
  expect(r.status).toBe("promoted");
  const promoted = a.inserted.find((c) => c.id === "claim-1" && c.status === "validated");
  expect(promoted!.recorded).toBe(2000);
  expect(promoted!.recordedSeq).toBe(3);
  const ev = a.events.filter((e) => e.op === "promote");
  expect(ev).toHaveLength(1);
  expect(ev[0].toStatus).toBe("validated");
  expect(ev[0].reason).toBe("passed");
});

it("promote missing claim returns not_found with no write or event", async () => {
  const a = fakeAsyncAdapter();
  const p = new AsyncPromoter(a, schema, "c1", () => 1000);
  const r = await p.promote("nope" as ClaimId, "validated", { writer: "u" });
  expect(r.status).toBe("not_found");
  expect(a.inserted).toHaveLength(0);
  expect(a.events).toHaveLength(0);
});

it("promote backward transition returns invalid_transition with no write", async () => {
  const target: Claim = {
    ...baseCandidate,
    id: "claim-2" as any,
    scopeHash: "_",
    valueHash: "abcdef1234567890",
    recorded: 1,
    recordedSeq: 0,
    status: "validated",
    corpusId: "c1" as any,
  };
  const a = fakeAsyncAdapter([target]);
  const p = new AsyncPromoter(a, schema, "c1", () => 1000);
  const r = await p.promote("claim-2" as ClaimId, "candidate", { writer: "u" });
  expect(r.status).toBe("invalid_transition");
  expect(a.inserted).toHaveLength(0);
});

it("promote idempotency: second call with same key returns duplicate", async () => {
  const target: Claim = {
    ...baseCandidate,
    id: "claim-3" as any,
    scopeHash: "_",
    valueHash: "abcdef1234567890",
    recorded: 1,
    recordedSeq: 0,
    status: "candidate",
    corpusId: "c1" as any,
  };
  const a = fakeAsyncAdapter([target]);
  const p = new AsyncPromoter(a, schema, "c1", () => 1000);
  const r1 = await p.promote("claim-3" as ClaimId, "validated", { writer: "u", idempotencyKey: "pk" });
  const r2 = await p.promote("claim-3" as ClaimId, "validated", { writer: "u", idempotencyKey: "pk" });
  expect(r1.status).toBe("promoted");
  expect(r2).toEqual({ id: "claim-3", status: "duplicate" });
});
