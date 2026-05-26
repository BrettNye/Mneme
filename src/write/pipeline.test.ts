import { Promoter } from "./pipeline.js";
import type { StorageAdapter, ExecutionPlan, IdempotencyRecord, ClaimEvent } from "../adapters/adapter.js";
import type { Claim } from "../core/claim.js";
import type { ClaimId } from "../core/ids.js";

function makeAdapter(preloaded: Claim[] = []): StorageAdapter & { inserted: Claim[]; deleted: ClaimId[]; events: ClaimEvent[] } {
  const store: Claim[] = [...preloaded];
  const inserted: Claim[] = [];
  const deleted: ClaimId[] = [];
  const events: ClaimEvent[] = [];
  const idempotencyStore = new Map<string, IdempotencyRecord>();
  return {
    inserted,
    deleted,
    events,
    query: (plan: ExecutionPlan) =>
      store.filter(
        (c) =>
          (!plan.subject || c.subject === plan.subject) &&
          (!plan.key || c.key === plan.key) &&
          (!plan.scopeHash || c.scopeHash === plan.scopeHash) &&
          (!plan.status || plan.status.includes(c.status))
      ),
    insertClaim: (c: Claim) => { store.push(c); inserted.push(c); },
    deleteClaim: (id: ClaimId) => {
      const idx = store.findIndex(c => c.id === id);
      if (idx !== -1) store.splice(idx, 1);
      deleted.push(id);
    },
    getClaim: (id: ClaimId) => store.find(c => c.id === id),
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
    maxRecordedSeq(): number {
      // Return the max recordedSeq among all claims in store, or -1 if empty
      if (store.length === 0) return -1;
      return Math.max(...store.map(c => c.recordedSeq));
    },
    appendEvent(e: ClaimEvent): void { events.push(e); },
    readEvents(_filter?: { corpusId?: string; claimId?: string; since?: number }): ClaimEvent[] { return [...events]; },
  } as StorageAdapter & { inserted: Claim[]; deleted: ClaimId[]; events: ClaimEvent[] };
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

// ======================================================
// commit — existing tests (regression)
// ======================================================

it("assigns id/recorded/scopeHash and inserts; recorded is monotonic", () => {
  const inserted: any[] = [];
  const events: ClaimEvent[] = [];
  const adapter = {
    query: () => [],
    insertClaim: (c: any) => inserted.push(c),
    deleteClaim: () => {},
    getIdempotencyRecord: () => undefined,
    putIdempotencyRecord: () => {},
    transaction<T>(fn: () => T): T { return fn(); },
    maxRecordedSeq(): number { return inserted.length > 0 ? Math.max(...inserted.map((c: any) => c.recordedSeq)) : -1; },
    appendEvent(e: ClaimEvent): void { events.push(e); },
    readEvents(): ClaimEvent[] { return []; },
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

it("rejected commit does NOT consume recordedSeq — DB-derived seq is used for next successful commit", () => {
  const existingClaim: Claim = {
    ...baseCandidate,
    id: "existing-id" as any,
    scopeHash: "_",
    valueHash: "deadbeef1234abcd",
    value: 99,
    recorded: Date.now(),
    recordedSeq: 7,   // existing claim at seq 7
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
  // Second commit — use a different key so no contradiction
  // With DB-derived seq: maxRecordedSeq() = 7 (unchanged because rejection wrote nothing), so next seq = 8
  const committed = p.commit(
    { ...baseCandidate, key: "repo.no_conflict", value: 5 },
    { policy: { kind: "always_accept" }, writer: "u" }
  );
  expect(committed.status).toBe("committed");
  // seq derives from DB: existingClaim at 7, rejection didn't write → next is 8
  expect(adapter.inserted[0].recordedSeq).toBe(8);
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

// ======================================================
// commit — new: events appended, seq from DB
// ======================================================

it("commit appends a commit event with corpusId, writer, claimId, recorded, recordedSeq", () => {
  const adapter = makeAdapter();
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any, "corpus-1");
  const result = p.commit(baseCandidate, { policy: { kind: "always_accept" }, writer: "alice" });
  expect(result.status).toBe("committed");
  expect(adapter.events).toHaveLength(1);
  const ev = adapter.events[0];
  expect(ev.op).toBe("commit");
  expect(ev.corpusId).toBe("corpus-1");
  expect(ev.writer).toBe("alice");
  expect(ev.claimId).toBe(result.id);
  expect(typeof ev.recorded).toBe("number");
  expect(typeof ev.recordedSeq).toBe("number");
});

it("rejected commit does NOT append any event", () => {
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
  p.commit(
    { ...baseCandidate, value: 42, confidence: { distribution: "beta" as const, parameters: { alpha: 1, beta: 9 }, raw: 0.1 } },
    { policy: { kind: "reject_on_contradiction" }, writer: "u" }
  );
  expect(adapter.events).toHaveLength(0);
});

it("new Promoter on same adapter continues DB-derived sequence", () => {
  const adapter = makeAdapter();
  const p1 = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  p1.commit(baseCandidate, { policy: { kind: "always_accept" }, writer: "u" });
  expect(adapter.inserted[0].recordedSeq).toBe(0);

  // New Promoter instance — should derive seq from DB (maxRecordedSeq+1 = 1)
  const p2 = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  p2.commit({ ...baseCandidate, key: "repo.y" }, { policy: { kind: "always_accept" }, writer: "u" });
  expect(adapter.inserted[1].recordedSeq).toBe(1);
});

// ======================================================
// supersede
// ======================================================

it("supersede inserts replacement with fresh id and no contradiction enforce", () => {
  const adapter = makeAdapter();
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any, "corp");
  // First, commit a claim to supersede
  const firstResult = p.commit(baseCandidate, { policy: { kind: "always_accept" }, writer: "u" });
  const deprecateId = firstResult.id as ClaimId;

  const replacement = { ...baseCandidate, key: "repo.z", value: 99 };
  const result = p.supersede(deprecateId, replacement, { writer: "alice" });

  expect(result.status).toBe("superseded");
  expect(typeof result.id).toBe("string");
  expect(result.id).not.toBe(deprecateId);
  // The old claim should have been deleted
  expect(adapter.deleted).toContain(deprecateId);
  // New claim was inserted
  const newClaim = adapter.inserted.find(c => c.id === result.id);
  expect(newClaim).toBeDefined();
  expect(newClaim!.value).toBe(99);
  expect(newClaim!.status).toBe("validated");
});

it("supersede validates replacement scope", () => {
  const adapter = makeAdapter();
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  const deprecateId = "some-id" as ClaimId;
  const replacement = { ...baseCandidate, scope: { undeclaredField: "x" } };
  expect(() =>
    p.supersede(deprecateId, replacement, { writer: "alice" })
  ).toThrow(/undeclared/i);
});

it("supersede: missing deprecateId is no-op for deletion but replacement still inserts", () => {
  const adapter = makeAdapter();
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  // "nonexistent" is not in store — getClaim returns undefined but deleteClaim is best-effort
  const result = p.supersede("nonexistent-id" as ClaimId, baseCandidate, { writer: "alice" });
  expect(result.status).toBe("superseded");
  // Replacement was still inserted
  expect(adapter.inserted.find(c => c.id === result.id)).toBeDefined();
  // deleteClaim was called (best-effort)
  expect(adapter.deleted).toContain("nonexistent-id");
});

it("supersede appends a supersede event with deprecatedId and new claimId", () => {
  const adapter = makeAdapter();
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any, "corp");
  const deprecateId = "old-id" as ClaimId;
  const result = p.supersede(deprecateId, baseCandidate, { writer: "bob" });
  const supersedeEvents = adapter.events.filter(e => e.op === "supersede");
  expect(supersedeEvents).toHaveLength(1);
  const ev = supersedeEvents[0];
  expect(ev.op).toBe("supersede");
  expect(ev.deprecatedId).toBe("old-id");
  expect(ev.claimId).toBe(result.id);
  expect(ev.writer).toBe("bob");
  expect(ev.corpusId).toBe("corp");
});

it("supersede idempotency: second call with same key returns duplicate", () => {
  const adapter = makeAdapter();
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  const deprecateId = "dep-id" as ClaimId;
  const r1 = p.supersede(deprecateId, baseCandidate, { writer: "u", idempotencyKey: "sup-key" });
  expect(r1.status).toBe("superseded");
  const r2 = p.supersede(deprecateId, baseCandidate, { writer: "u", idempotencyKey: "sup-key" });
  expect(r2.status).toBe("duplicate");
  expect(r2.id).toBe(r1.id);
  // Only one insert happened
  expect(adapter.inserted.filter(c => c.id === r1.id)).toHaveLength(1);
});

it("supersede is atomic: if insertClaim throws, the deprecation rolls back too", () => {
  const store: Claim[] = [];
  const inserted: Claim[] = [];
  const deleted: ClaimId[] = [];
  const events: ClaimEvent[] = [];
  const idempotencyStore = new Map<string, IdempotencyRecord>();
  let shouldThrow = false;

  const adapter: StorageAdapter & { inserted: Claim[]; deleted: ClaimId[]; events: ClaimEvent[] } = {
    inserted,
    deleted,
    events,
    query: () => [],
    insertClaim: (c: Claim) => {
      if (shouldThrow) throw new Error("insertClaim failed");
      store.push(c);
      inserted.push(c);
    },
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
    // Real-style transaction: if fn throws, rollback by restoring state
    transaction<T>(fn: () => T): T {
      const deletedSnapshot = [...deleted];
      const insertedSnapshot = [...inserted];
      const eventsSnapshot = [...events];
      try {
        return fn();
      } catch (e) {
        // Rollback: restore deleted/inserted/events arrays to pre-transaction state
        deleted.length = 0;
        deleted.push(...deletedSnapshot);
        inserted.length = 0;
        inserted.push(...insertedSnapshot);
        events.length = 0;
        events.push(...eventsSnapshot);
        throw e;
      }
    },
    maxRecordedSeq(): number { return inserted.length > 0 ? Math.max(...inserted.map(c => c.recordedSeq)) : -1; },
    appendEvent(e: ClaimEvent): void { events.push(e); },
    readEvents(): ClaimEvent[] { return [...events]; },
  } as any;

  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  shouldThrow = true;
  const deprecateId = "the-deprecated-id" as ClaimId;
  expect(() => p.supersede(deprecateId, baseCandidate, { writer: "u" })).toThrow("insertClaim failed");

  // After rollback: deleted array should be back to empty (no permanent deletion)
  expect(deleted).toHaveLength(0);
  // No events captured
  expect(events).toHaveLength(0);
  // No inserts
  expect(inserted).toHaveLength(0);
});

it("supersede does NOT call contradiction enforce", () => {
  // Set up a "conflicting" claim in store — with strict reject_on_contradiction, supersede should still succeed
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
  // replacement has lower confidence — would be "rejected" by reject_on_contradiction if enforce was called
  const replacement = {
    ...baseCandidate,
    value: 42,
    confidence: { distribution: "beta" as const, parameters: { alpha: 1, beta: 9 }, raw: 0.1 },
  };
  // supersede should succeed without rejection (no enforce call)
  const result = p.supersede("dep-id" as ClaimId, replacement, { writer: "u" });
  expect(result.status).toBe("superseded");
});

// ======================================================
// promote
// ======================================================

it("promote candidate→provisional succeeds", () => {
  const target: Claim = {
    ...baseCandidate,
    id: "claim-1" as any,
    scopeHash: "_",
    valueHash: "abcdef1234567890",
    recorded: 1000,
    recordedSeq: 0,
    status: "candidate",
  };
  const adapter = makeAdapter([target]);
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  const result = p.promote("claim-1" as ClaimId, "provisional", { writer: "u" });
  expect(result.status).toBe("promoted");
  expect(result.id).toBe("claim-1");
  // The claim's own recorded/recordedSeq unchanged
  const promoted = adapter.inserted.find(c => c.status === "provisional");
  expect(promoted).toBeDefined();
  expect(promoted!.recorded).toBe(1000);
  expect(promoted!.recordedSeq).toBe(0);
});

it("promote candidate→validated succeeds", () => {
  const target: Claim = {
    ...baseCandidate,
    id: "claim-2" as any,
    scopeHash: "_",
    valueHash: "abcdef1234567890",
    recorded: 2000,
    recordedSeq: 3,
    status: "candidate",
  };
  const adapter = makeAdapter([target]);
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  const result = p.promote("claim-2" as ClaimId, "validated", { writer: "u" });
  expect(result.status).toBe("promoted");
});

it("promote provisional→validated succeeds", () => {
  const target: Claim = {
    ...baseCandidate,
    id: "claim-3" as any,
    scopeHash: "_",
    valueHash: "abcdef1234567890",
    recorded: 3000,
    recordedSeq: 5,
    status: "provisional",
  };
  const adapter = makeAdapter([target]);
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  const result = p.promote("claim-3" as ClaimId, "validated", { writer: "u" });
  expect(result.status).toBe("promoted");
  const promoted = adapter.inserted.find(c => c.status === "validated");
  expect(promoted!.recorded).toBe(3000);  // unchanged
  expect(promoted!.recordedSeq).toBe(5);  // unchanged
});

it("promote any→deprecated succeeds", () => {
  const target: Claim = {
    ...baseCandidate,
    id: "claim-4" as any,
    scopeHash: "_",
    valueHash: "abcdef1234567890",
    recorded: 4000,
    recordedSeq: 2,
    status: "validated",
  };
  const adapter = makeAdapter([target]);
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  const result = p.promote("claim-4" as ClaimId, "deprecated", { writer: "u" });
  expect(result.status).toBe("promoted");
});

it("promote backward transition returns invalid_transition", () => {
  const target: Claim = {
    ...baseCandidate,
    id: "claim-5" as any,
    scopeHash: "_",
    valueHash: "abcdef1234567890",
    recorded: 5000,
    recordedSeq: 1,
    status: "validated",
  };
  const adapter = makeAdapter([target]);
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  // validated → candidate is backward
  const result = p.promote("claim-5" as ClaimId, "candidate", { writer: "u" });
  expect(result.status).toBe("invalid_transition");
  // no inserts
  expect(adapter.inserted).toHaveLength(0);
});

it("promote provisional→candidate returns invalid_transition", () => {
  const target: Claim = {
    ...baseCandidate,
    id: "claim-6" as any,
    scopeHash: "_",
    valueHash: "abcdef1234567890",
    recorded: 6000,
    recordedSeq: 2,
    status: "provisional",
  };
  const adapter = makeAdapter([target]);
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  const result = p.promote("claim-6" as ClaimId, "candidate", { writer: "u" });
  expect(result.status).toBe("invalid_transition");
});

it("promote missing claim returns not_found, no write or event", () => {
  const adapter = makeAdapter();
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  const result = p.promote("nonexistent" as ClaimId, "validated", { writer: "u" });
  expect(result.status).toBe("not_found");
  expect(adapter.inserted).toHaveLength(0);
  expect(adapter.events).toHaveLength(0);
});

it("promote appends a promote event with reason and the core's fresh stamp", () => {
  const target: Claim = {
    ...baseCandidate,
    id: "claim-7" as any,
    scopeHash: "_",
    valueHash: "abcdef1234567890",
    recorded: 7000,
    recordedSeq: 0,
    status: "candidate",
  };
  const adapter = makeAdapter([target]);
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any, "corp-2");
  const result = p.promote("claim-7" as ClaimId, "validated", { writer: "carol", reason: "passed review" });
  expect(result.status).toBe("promoted");
  const promoteEvents = adapter.events.filter(e => e.op === "promote");
  expect(promoteEvents).toHaveLength(1);
  const ev = promoteEvents[0];
  expect(ev.op).toBe("promote");
  expect(ev.toStatus).toBe("validated");
  expect(ev.reason).toBe("passed review");
  expect(ev.claimId).toBe("claim-7");
  expect(ev.corpusId).toBe("corp-2");
  expect(ev.writer).toBe("carol");
  // The event's recorded/recordedSeq are fresh (not the claim's 7000/0)
  expect(ev.recorded).toBeGreaterThan(0);
  expect(ev.recordedSeq).toBeGreaterThanOrEqual(1); // DB had seq=0 so core gives 1
});

it("promote claim's recorded/recordedSeq unchanged after promotion", () => {
  const target: Claim = {
    ...baseCandidate,
    id: "claim-8" as any,
    scopeHash: "_",
    valueHash: "abcdef1234567890",
    recorded: 8888,
    recordedSeq: 42,
    status: "provisional",
  };
  const adapter = makeAdapter([target]);
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  p.promote("claim-8" as ClaimId, "validated", { writer: "u" });
  const promoted = adapter.inserted.find(c => c.id === "claim-8" && c.status === "validated");
  expect(promoted!.recorded).toBe(8888);
  expect(promoted!.recordedSeq).toBe(42);
});

it("promote idempotency: second call with same key returns duplicate", () => {
  const target: Claim = {
    ...baseCandidate,
    id: "claim-9" as any,
    scopeHash: "_",
    valueHash: "abcdef1234567890",
    recorded: 9000,
    recordedSeq: 0,
    status: "candidate",
  };
  const adapter = makeAdapter([target]);
  const p = new Promoter(adapter, { scopeFields: {}, scalarPseudocount: {} } as any);
  const r1 = p.promote("claim-9" as ClaimId, "validated", { writer: "u", idempotencyKey: "promo-key" });
  expect(r1.status).toBe("promoted");
  const r2 = p.promote("claim-9" as ClaimId, "validated", { writer: "u", idempotencyKey: "promo-key" });
  expect(r2.status).toBe("duplicate");
  expect(r2.id).toBe("claim-9");
});
