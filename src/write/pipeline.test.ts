import { Promoter } from "./pipeline.js";
import type { StorageAdapter, ExecutionPlan, IdempotencyRecord, ClaimEvent } from "../adapters/adapter.js";
import type { Claim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";

function makeAdapter(preloaded: Claim[] = []): StorageAdapter & { inserted: Claim[]; deleted: ClaimId[] } {
  const store: Claim[] = [...preloaded];
  const inserted: Claim[] = [];
  const deleted: ClaimId[] = [];
  const idempotencyStore = new Map<string, IdempotencyRecord>();
  return {
    inserted,
    deleted,
    query: (plan: ExecutionPlan) =>
      store.filter(
        (c) =>
          (!plan.subject || c.subject === plan.subject) &&
          (!plan.key || c.key === plan.key) &&
          (!plan.scopeHash || c.scopeHash === plan.scopeHash) &&
          (!plan.status || plan.status.includes(c.status))
      ),
    insertClaim: (c: Claim) => { store.push(c); inserted.push(c); },
    deleteClaim: (id: ClaimId) => { deleted.push(id); },
    getClaim: () => undefined,
    insertBatch: () => {},
    getIdempotencyRecord: (scope: string, key: string) => idempotencyStore.get(`${scope}::${key}`),
    putIdempotencyRecord: (scope: string, key: string, rec: IdempotencyRecord) => { idempotencyStore.set(`${scope}::${key}`, rec); },
    capabilities: () => ({
      valuePredicateSupport: {
        equality: "fallback_in_memory",
        range: "fallback_in_memory",
        set_membership: "fallback_in_memory",
        regex: "fallback_in_memory",
        structural_pattern: "fallback_in_memory",
        null_check: "fallback_in_memory",
      },
    }),
    transaction<T>(fn: () => T): T { return fn(); },
    maxRecordedSeq(): number { return 0; },
    appendEvent(_e: ClaimEvent): void {},
    readEvents(_filter?: { corpusId?: string; claimId?: string; since?: number }): ClaimEvent[] { return []; },
  } as StorageAdapter & { inserted: Claim[]; deleted: ClaimId[] };
}

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

it("assigns id/recorded/scopeHash and inserts; recorded is monotonic", () => {
  const inserted: any[] = [];
  const adapter = {
    query: () => [],
    insertClaim: (c: any) => inserted.push(c),
    deleteClaim: () => {},
    getIdempotencyRecord: () => undefined,
    putIdempotencyRecord: () => {},
  } as any;
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  const r1 = p.commit({ workspace: "w", subject: "repo", key: "repo.x", scope: {}, value: 1, confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 } } as any, { policy: { kind: "always_accept" }, writer: "u" });
  expect(r1.status).toBe("committed");
  expect(inserted[0].scopeHash).toBe("_");
  expect(inserted[0].recordedSeq).toBe(0);
});

it("assigns a UUID id on commit", () => {
  const adapter = makeAdapter();
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  const result = p.commit(baseCandidate, { policy: { kind: "always_accept" }, writer: "u" });
  expect(result.status).toBe("committed");
  expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(adapter.inserted[0].id).toBe(result.id);
});

it("computes scopeHash and valueHash on insert", () => {
  const adapter = makeAdapter();
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  p.commit(baseCandidate, { policy: { kind: "always_accept" }, writer: "u" });
  const inserted = adapter.inserted[0];
  expect(inserted.scopeHash).toBe("_"); // empty scope
  expect(typeof inserted.valueHash).toBe("string");
  expect(inserted.valueHash.length).toBe(16);
});

it("assigns default status=validated when candidate omits status", () => {
  const adapter = makeAdapter();
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  const candidate = { ...baseCandidate };
  delete (candidate as any).status;
  p.commit(candidate, { policy: { kind: "always_accept" }, writer: "u" });
  expect(adapter.inserted[0].status).toBe("validated");
});

it("recordedSeq increments monotonically across commits", () => {
  const adapter = makeAdapter();
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  p.commit(baseCandidate, { policy: { kind: "always_accept" }, writer: "u" });
  p.commit({ ...baseCandidate, key: "repo.y" }, { policy: { kind: "always_accept" }, writer: "u" });
  expect(adapter.inserted[0].recordedSeq).toBe(0);
  expect(adapter.inserted[1].recordedSeq).toBe(1);
});

it("throws when scope contains undeclared field (validateScope)", () => {
  const adapter = makeAdapter();
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  const candidate = { ...baseCandidate, scope: { undeclaredField: "x" } };
  expect(() =>
    p.commit(candidate, { policy: { kind: "always_accept" }, writer: "u" })
  ).toThrow(/undeclared/i);
  expect(adapter.inserted).toHaveLength(0);
});

it("returns status=rejected and does NOT insert when reject_on_contradiction fires", () => {
  // existing claim has higher confidence, so the new candidate with lower confidence is rejected
  const existingClaim: Claim = {
    ...baseCandidate,
    id: "existing-id" as any,
    scopeHash: "_",
    valueHash: "deadbeef1234abcd", // different value
    value: 99,
    recorded: Date.now(),
    recordedSeq: 0,
    status: "validated",
    confidence: { distribution: "beta" as const, parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
  };
  const adapter = makeAdapter([existingClaim]);
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  // new candidate has lower confidence
  const candidate = {
    ...baseCandidate,
    value: 42,
    confidence: { distribution: "beta" as const, parameters: { alpha: 1, beta: 9 }, raw: 0.1 },
  };
  const result = p.commit(candidate, { policy: { kind: "reject_on_contradiction" }, writer: "u" });
  expect(result.status).toBe("rejected");
  expect(adapter.inserted).toHaveLength(0);
});

it("accept_and_resolve calls deleteClaim on the loser before insert", () => {
  const existingClaim: Claim = {
    ...baseCandidate,
    id: "loser-id" as any,
    scopeHash: "_",
    valueHash: "deadbeef1234abcd",
    value: 99,
    recorded: Date.now(),
    recordedSeq: 0,
    status: "validated",
    confidence: { distribution: "beta" as const, parameters: { alpha: 1, beta: 9 }, raw: 0.1 },
  };
  const adapter = makeAdapter([existingClaim]);
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  // new candidate has higher confidence — should win
  const candidate = {
    ...baseCandidate,
    value: 42,
    confidence: { distribution: "beta" as const, parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
  };
  const result = p.commit(candidate, {
    policy: { kind: "accept_and_resolve", rule: "deprecate_lower" },
    writer: "u",
  });
  expect(result.status).toBe("committed");
  expect(adapter.deleted).toContain("loser-id");
  expect(adapter.inserted).toHaveLength(1);
});

it("rejected commit does NOT consume recordedSeq — next successful commit gets seq 0", () => {
  const existingClaim: Claim = {
    ...baseCandidate,
    id: "existing-id" as any,
    scopeHash: "_",
    valueHash: "deadbeef1234abcd",
    value: 99,
    recorded: Date.now(),
    recordedSeq: 0,
    status: "validated",
    confidence: { distribution: "beta" as const, parameters: { alpha: 9, beta: 1 }, raw: 0.9 },
  };
  const adapter = makeAdapter([existingClaim]);
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  // First commit — lower confidence, should be rejected
  const rejected = p.commit(
    { ...baseCandidate, value: 42, confidence: { distribution: "beta" as const, parameters: { alpha: 1, beta: 9 }, raw: 0.1 } },
    { policy: { kind: "reject_on_contradiction" }, writer: "u" }
  );
  expect(rejected.status).toBe("rejected");
  // Second commit — use a different key so no contradiction; seq must still be 0
  const adapter2 = makeAdapter();
  const p2 = new Promoter(adapter2, { scopeFields: {}, scalarPseudocount: {} } as any);
  // Simulate on same promoter: after rejection, seq must not have incremented
  const committed = p.commit(
    { ...baseCandidate, key: "repo.no_conflict", value: 5 },
    { policy: { kind: "always_accept" }, writer: "u" }
  );
  expect(committed.status).toBe("committed");
  expect(adapter.inserted[0].recordedSeq).toBe(0);
});

it("idempotency replay returns original id with status=duplicate, no second insert", () => {
  const adapter = makeAdapter();
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  const r1 = p.commit(baseCandidate, {
    policy: { kind: "always_accept" },
    writer: "u",
    idempotencyKey: "key-abc",
  });
  expect(r1.status).toBe("committed");
  const r2 = p.commit(baseCandidate, {
    policy: { kind: "always_accept" },
    writer: "u",
    idempotencyKey: "key-abc",
  });
  expect(r2.status).toBe("duplicate");
  expect(r2.id).toBe(r1.id);
  expect(adapter.inserted).toHaveLength(1); // no second insert
});
