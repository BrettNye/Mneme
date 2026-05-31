import { createSqliteAdapter } from "./sqlite.js";
import type { Claim } from "../core/claim.js";
import type { ClaimId, ProfileId, WorkspaceId } from "../core/ids.js";
import type { ClaimEvent, AnchoredRootRow } from "./adapter.js";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeValidatedClaim(overrides: Partial<Claim> = {}): Claim {
  const base: Claim = {
    id: crypto.randomUUID() as ClaimId,
    profile: "default" as ProfileId,
    workspace: "test-workspace" as WorkspaceId,
    subject: "repo",
    key: "repo.test-command",
    scope: {},
    scopeHash: "_",
    value: "npm test",
    valueHash: "abc123def456",
    confidence: {
      distribution: "beta",
      parameters: { alpha: 8, beta: 2 },
      raw: 0.8,
      effective: 0.75,
    },
    valid: { from: 0, to: Infinity },
    recorded: 1716000000000,
    recordedSeq: 1,
    status: "validated",
    source: "manual",
    provenance: { workflow: "test-workflow", runId: "run-1" },
    evidence: [],
    audience: {},
    tags: ["ci", "build"],
    schema: "1.0",
  };
  return { ...base, ...overrides };
}

it("round-trips a claim and soft-deletes by id", () => {
  const a = createSqliteAdapter();
  const claim = makeValidatedClaim({ subject: "repo", key: "repo.test-command" });
  a.insertClaim(claim);
  expect(a.getClaim(claim.id)?.subject).toBe("repo");
  a.deleteClaim(claim.id);
  expect(a.getClaim(claim.id)?.status).toBe("deprecated");
});

it("round-trips all scalar fields correctly", () => {
  const a = createSqliteAdapter();
  const claim = makeValidatedClaim();
  a.insertClaim(claim);
  const fetched = a.getClaim(claim.id)!;
  expect(fetched.id).toBe(claim.id);
  expect(fetched.profile).toBe(claim.profile);
  expect(fetched.workspace).toBe(claim.workspace);
  expect(fetched.subject).toBe(claim.subject);
  expect(fetched.key).toBe(claim.key);
  expect(fetched.scopeHash).toBe(claim.scopeHash);
  expect(fetched.valueHash).toBe(claim.valueHash);
  expect(fetched.recorded).toBe(claim.recorded);
  expect(fetched.recordedSeq).toBe(claim.recordedSeq);
  expect(fetched.status).toBe(claim.status);
  expect(fetched.source).toBe(claim.source);
  expect(fetched.schema).toBe(claim.schema);
});

it("round-trips valid.to = Infinity", () => {
  const a = createSqliteAdapter();
  const claim = makeValidatedClaim({ valid: { from: 0, to: Infinity } });
  a.insertClaim(claim);
  const fetched = a.getClaim(claim.id)!;
  expect(fetched.valid.from).toBe(0);
  expect(fetched.valid.to).toBe(Infinity);
});

it("round-trips confidence params via registry (beta distribution)", () => {
  const a = createSqliteAdapter();
  const claim = makeValidatedClaim({
    confidence: {
      distribution: "beta",
      parameters: { alpha: 3, beta: 7 },
      raw: 0.3,
      effective: 0.28,
    },
  });
  a.insertClaim(claim);
  const fetched = a.getClaim(claim.id)!;
  expect(fetched.confidence.distribution).toBe("beta");
  expect((fetched.confidence.parameters as { alpha: number; beta: number }).alpha).toBe(3);
  expect((fetched.confidence.parameters as { alpha: number; beta: number }).beta).toBe(7);
  expect(fetched.confidence.raw).toBe(0.3);
  expect(fetched.confidence.effective).toBe(0.28);
});

it("round-trips confidence params via registry (scalar distribution)", () => {
  const a = createSqliteAdapter();
  const claim = makeValidatedClaim({
    confidence: {
      distribution: "scalar",
      parameters: { p: 0.95 },
      raw: 0.95,
    },
  });
  a.insertClaim(claim);
  const fetched = a.getClaim(claim.id)!;
  expect(fetched.confidence.distribution).toBe("scalar");
  expect((fetched.confidence.parameters as { p: number }).p).toBe(0.95);
  expect(fetched.confidence.raw).toBe(0.95);
  expect(fetched.confidence.effective).toBeUndefined();
});

it("round-trips scope object", () => {
  const a = createSqliteAdapter();
  const claim = makeValidatedClaim({ scope: { env: "prod", region: "us-east" }, scopeHash: "abc123" });
  a.insertClaim(claim);
  const fetched = a.getClaim(claim.id)!;
  expect(fetched.scope).toEqual({ env: "prod", region: "us-east" });
});

it("round-trips value (complex object)", () => {
  const a = createSqliteAdapter();
  const claim = makeValidatedClaim({ value: { cmd: "npm test", timeout: 60 } });
  a.insertClaim(claim);
  const fetched = a.getClaim(claim.id)!;
  expect(fetched.value).toEqual({ cmd: "npm test", timeout: 60 });
});

it("round-trips evidence array", () => {
  const a = createSqliteAdapter();
  const claim = makeValidatedClaim({
    evidence: [
      { kind: "external", uri: "https://example.com/doc", contentHash: "xyz" },
      { kind: "document", sourceDocumentId: "doc-1", extractionMethod: "regex" },
    ],
  });
  a.insertClaim(claim);
  const fetched = a.getClaim(claim.id)!;
  expect(fetched.evidence).toHaveLength(2);
  expect(fetched.evidence[0]).toEqual({ kind: "external", uri: "https://example.com/doc", contentHash: "xyz" });
  expect(fetched.evidence[1]).toEqual({ kind: "document", sourceDocumentId: "doc-1", extractionMethod: "regex" });
});

it("round-trips tags array", () => {
  const a = createSqliteAdapter();
  const claim = makeValidatedClaim({ tags: ["ci", "build", "nightly"] });
  a.insertClaim(claim);
  const fetched = a.getClaim(claim.id)!;
  expect(fetched.tags).toEqual(["ci", "build", "nightly"]);
});

it("round-trips provenance object", () => {
  const a = createSqliteAdapter();
  const claim = makeValidatedClaim({
    provenance: { workflow: "wf-1", runId: "run-42", nodeId: "node-7", persona: "agent-x" },
  });
  a.insertClaim(claim);
  const fetched = a.getClaim(claim.id)!;
  expect(fetched.provenance).toEqual({ workflow: "wf-1", runId: "run-42", nodeId: "node-7", persona: "agent-x" });
});

it("insertBatch inserts all claims atomically", () => {
  const a = createSqliteAdapter();
  const claims = [
    makeValidatedClaim({ subject: "repo", key: "repo.cmd" }),
    makeValidatedClaim({ subject: "repo", key: "repo.lint" }),
    makeValidatedClaim({ subject: "ci", key: "ci.pipeline" }),
  ];
  a.insertBatch(claims);
  for (const c of claims) {
    expect(a.getClaim(c.id)?.id).toBe(c.id);
  }
});

it("query filters by subject", () => {
  const a = createSqliteAdapter();
  const c1 = makeValidatedClaim({ subject: "repo", key: "repo.cmd" });
  const c2 = makeValidatedClaim({ subject: "ci", key: "ci.pipeline" });
  a.insertClaim(c1);
  a.insertClaim(c2);
  const results = a.query({ corpusId: "c1", subject: "repo" });
  expect(results).toHaveLength(1);
  expect(results[0].subject).toBe("repo");
});

it("query filters by key", () => {
  const a = createSqliteAdapter();
  const c1 = makeValidatedClaim({ key: "repo.cmd" });
  const c2 = makeValidatedClaim({ key: "repo.lint" });
  a.insertClaim(c1);
  a.insertClaim(c2);
  const results = a.query({ corpusId: "c1", key: "repo.cmd" });
  expect(results).toHaveLength(1);
  expect(results[0].key).toBe("repo.cmd");
});

it("query filters by status (IN list)", () => {
  const a = createSqliteAdapter();
  const c1 = makeValidatedClaim({ status: "validated" });
  const c2 = makeValidatedClaim({ status: "deprecated" });
  const c3 = makeValidatedClaim({ status: "candidate" });
  a.insertClaim(c1);
  a.insertClaim(c2);
  a.insertClaim(c3);
  const results = a.query({ corpusId: "c1", status: ["validated", "candidate"] });
  expect(results).toHaveLength(2);
  expect(results.map((r) => r.status).sort()).toEqual(["candidate", "validated"]);
});

it("query filters by scopeHash", () => {
  const a = createSqliteAdapter();
  const c1 = makeValidatedClaim({ scopeHash: "hash-a" });
  const c2 = makeValidatedClaim({ scopeHash: "hash-b" });
  a.insertClaim(c1);
  a.insertClaim(c2);
  const results = a.query({ corpusId: "c1", scopeHash: "hash-a" });
  expect(results).toHaveLength(1);
  expect(results[0].scopeHash).toBe("hash-a");
});

it("query filters by recordedAtMost", () => {
  const a = createSqliteAdapter();
  const c1 = makeValidatedClaim({ recorded: 1000 });
  const c2 = makeValidatedClaim({ recorded: 2000 });
  const c3 = makeValidatedClaim({ recorded: 3000 });
  a.insertClaim(c1);
  a.insertClaim(c2);
  a.insertClaim(c3);
  const results = a.query({ corpusId: "c1", recordedAtMost: 2000 });
  expect(results).toHaveLength(2);
  expect(results.every((r) => r.recorded <= 2000)).toBe(true);
});

it("query returns all claims when no filters given", () => {
  const a = createSqliteAdapter();
  const claims = [
    makeValidatedClaim({ key: "repo.a" }),
    makeValidatedClaim({ key: "repo.b" }),
  ];
  a.insertBatch(claims);
  const results = a.query({ corpusId: "c1" });
  expect(results).toHaveLength(2);
});

it("query combined subject + key + status filters", () => {
  const a = createSqliteAdapter();
  const c1 = makeValidatedClaim({ subject: "repo", key: "repo.cmd", status: "validated" });
  const c2 = makeValidatedClaim({ subject: "repo", key: "repo.cmd", status: "deprecated" });
  const c3 = makeValidatedClaim({ subject: "ci", key: "ci.pipeline", status: "validated" });
  a.insertClaim(c1);
  a.insertClaim(c2);
  a.insertClaim(c3);
  const results = a.query({ corpusId: "c1", subject: "repo", key: "repo.cmd", status: ["validated"] });
  expect(results).toHaveLength(1);
  expect(results[0].id).toBe(c1.id);
});

it("idempotency get/put round-trip by (scope, key)", () => {
  const a = createSqliteAdapter();
  expect(a.getIdempotencyRecord("scope1", "key1")).toBeUndefined();
  const rec = { result: '{"status":"ok"}', createdAt: 1716000000000 };
  a.putIdempotencyRecord("scope1", "key1", rec);
  const fetched = a.getIdempotencyRecord("scope1", "key1")!;
  expect(fetched.result).toBe(rec.result);
  expect(fetched.createdAt).toBe(rec.createdAt);
});

it("idempotency put is idempotent (UPSERT updates existing)", () => {
  const a = createSqliteAdapter();
  const rec1 = { result: "first", createdAt: 1000 };
  const rec2 = { result: "second", createdAt: 2000 };
  a.putIdempotencyRecord("scope1", "key1", rec1);
  a.putIdempotencyRecord("scope1", "key1", rec2);
  const fetched = a.getIdempotencyRecord("scope1", "key1")!;
  expect(fetched.result).toBe("second");
  expect(fetched.createdAt).toBe(2000);
});

it("idempotency keys are independent per (scope, key) pair", () => {
  const a = createSqliteAdapter();
  a.putIdempotencyRecord("scope1", "key1", { result: "r1", createdAt: 1 });
  a.putIdempotencyRecord("scope1", "key2", { result: "r2", createdAt: 2 });
  a.putIdempotencyRecord("scope2", "key1", { result: "r3", createdAt: 3 });
  expect(a.getIdempotencyRecord("scope1", "key1")?.result).toBe("r1");
  expect(a.getIdempotencyRecord("scope1", "key2")?.result).toBe("r2");
  expect(a.getIdempotencyRecord("scope2", "key1")?.result).toBe("r3");
});

it("declares every value-predicate kind as fallback_in_memory", () => {
  const caps = createSqliteAdapter().capabilities();
  for (const kind of ["equality","range","set_membership","regex","structural_pattern","null_check"] as const) {
    expect(caps.valuePredicateSupport[kind]).toBe("fallback_in_memory");
  }
});

it("getClaim returns undefined for non-existent id", () => {
  const a = createSqliteAdapter();
  expect(a.getClaim("non-existent-id" as ClaimId)).toBeUndefined();
});

it("fromRow omits effective key entirely when conf_effective is null (no stray undefined properties)", () => {
  const a = createSqliteAdapter();
  // scalar distribution with no effective set — effective should be absent, not present-as-undefined
  const claim = makeValidatedClaim({
    confidence: {
      distribution: "scalar",
      parameters: { p: 0.9 },
      raw: 0.9,
      // effective intentionally omitted
    },
  });
  a.insertClaim(claim);
  const fetched = a.getClaim(claim.id)!;
  expect("effective" in fetched.confidence).toBe(false);
});

it("insertClaim uses INSERT OR REPLACE semantics on id (upsert)", () => {
  const a = createSqliteAdapter();
  const claim = makeValidatedClaim({ value: "original" });
  a.insertClaim(claim);
  const updated = { ...claim, value: "updated" };
  a.insertClaim(updated);
  const fetched = a.getClaim(claim.id)!;
  expect(fetched.value).toBe("updated");
});

it("query filters by runIds (matches provenance.runId membership)", () => {
  const a = createSqliteAdapter();
  const c1 = makeValidatedClaim({ provenance: { workflow: "wf-1", runId: "r1" } });
  const c2 = makeValidatedClaim({ provenance: { workflow: "wf-1", runId: "r2" } });
  a.insertClaim(c1);
  a.insertClaim(c2);
  const results = a.query({ corpusId: "c1", runIds: ["r1"] });
  expect(results).toHaveLength(1);
  expect(results[0].provenance.runId).toBe("r1");
});

it("query with empty runIds returns all claims (no run_id constraint)", () => {
  const a = createSqliteAdapter();
  const c1 = makeValidatedClaim({ provenance: { workflow: "wf-1", runId: "r1" } });
  const c2 = makeValidatedClaim({ provenance: { workflow: "wf-1", runId: "r2" } });
  a.insertClaim(c1);
  a.insertClaim(c2);
  const results = a.query({ corpusId: "c1", runIds: [] });
  expect(results).toHaveLength(2);
});

it("query with absent runIds returns all claims (no run_id constraint)", () => {
  const a = createSqliteAdapter();
  const c1 = makeValidatedClaim({ provenance: { workflow: "wf-1", runId: "r1" } });
  const c2 = makeValidatedClaim({ provenance: { workflow: "wf-1", runId: "r2" } });
  a.insertClaim(c1);
  a.insertClaim(c2);
  const results = a.query({ corpusId: "c1" });
  expect(results).toHaveLength(2);
});

it("query filters by runIds combined with status", () => {
  const a = createSqliteAdapter();
  const c1 = makeValidatedClaim({ provenance: { workflow: "wf-1", runId: "r1" }, status: "validated" });
  const c2 = makeValidatedClaim({ provenance: { workflow: "wf-1", runId: "r1" }, status: "deprecated" });
  const c3 = makeValidatedClaim({ provenance: { workflow: "wf-1", runId: "r2" }, status: "validated" });
  a.insertClaim(c1);
  a.insertClaim(c2);
  a.insertClaim(c3);
  const results = a.query({ corpusId: "c1", runIds: ["r1"], status: ["validated"] });
  expect(results).toHaveLength(1);
  expect(results[0].id).toBe(c1.id);
});

it("query filters by multiple runIds (IN set)", () => {
  const a = createSqliteAdapter();
  const c1 = makeValidatedClaim({ provenance: { workflow: "wf-1", runId: "r1" } });
  const c2 = makeValidatedClaim({ provenance: { workflow: "wf-1", runId: "r2" } });
  const c3 = makeValidatedClaim({ provenance: { workflow: "wf-1", runId: "r3" } });
  a.insertClaim(c1);
  a.insertClaim(c2);
  a.insertClaim(c3);
  const results = a.query({ corpusId: "c1", runIds: ["r1", "r3"] });
  expect(results).toHaveLength(2);
  expect(results.map((r) => r.provenance.runId).sort()).toEqual(["r1", "r3"]);
});

// --- New write-primitives tests ---

it("maxRecordedSeq returns 0 on empty db", () => {
  const a = createSqliteAdapter();
  expect(a.maxRecordedSeq()).toBe(0);
});

it("maxRecordedSeq returns true max recorded_seq after inserts", () => {
  const a = createSqliteAdapter();
  a.insertClaim(makeValidatedClaim({ recordedSeq: 3 }));
  a.insertClaim(makeValidatedClaim({ recordedSeq: 7 }));
  a.insertClaim(makeValidatedClaim({ recordedSeq: 2 }));
  expect(a.maxRecordedSeq()).toBe(7);
});

it("appendEvent and readEvents round-trips a commit event", () => {
  const a = createSqliteAdapter();
  const event: ClaimEvent = {
    op: "commit",
    corpusId: "corp-1",
    writer: "writer-1",
    claimId: "claim-abc",
    recorded: 1716000000000,
    recordedSeq: 1,
  };
  a.appendEvent(event);
  const events = a.readEvents();
  expect(events).toHaveLength(1);
  expect(events[0].op).toBe("commit");
  expect(events[0].corpusId).toBe("corp-1");
  expect(events[0].writer).toBe("writer-1");
  expect(events[0].claimId).toBe("claim-abc");
  expect(events[0].recorded).toBe(1716000000000);
  expect(events[0].recordedSeq).toBe(1);
});

it("appendEvent round-trips a supersede event with deprecatedId", () => {
  const a = createSqliteAdapter();
  const event: ClaimEvent = {
    op: "supersede",
    corpusId: "corp-1",
    writer: "writer-1",
    claimId: "claim-new",
    deprecatedId: "claim-old",
    recorded: 1716000001000,
    recordedSeq: 2,
  };
  a.appendEvent(event);
  const events = a.readEvents();
  expect(events[0].deprecatedId).toBe("claim-old");
});

it("appendEvent round-trips a promote event with toStatus and reason", () => {
  const a = createSqliteAdapter();
  const event: ClaimEvent = {
    op: "promote",
    corpusId: "corp-1",
    writer: "writer-1",
    claimId: "claim-abc",
    toStatus: "validated",
    reason: "reviewed",
    recorded: 1716000002000,
    recordedSeq: 3,
  };
  a.appendEvent(event);
  const events = a.readEvents();
  expect(events[0].toStatus).toBe("validated");
  expect(events[0].reason).toBe("reviewed");
});

it("readEvents returns events in insertion order", () => {
  const a = createSqliteAdapter();
  const e1: ClaimEvent = { op: "commit", corpusId: "c", writer: "w", claimId: "id-1", recorded: 1000, recordedSeq: 1 };
  const e2: ClaimEvent = { op: "commit", corpusId: "c", writer: "w", claimId: "id-2", recorded: 2000, recordedSeq: 2 };
  const e3: ClaimEvent = { op: "commit", corpusId: "c", writer: "w", claimId: "id-3", recorded: 3000, recordedSeq: 3 };
  a.appendEvent(e1);
  a.appendEvent(e2);
  a.appendEvent(e3);
  const events = a.readEvents();
  expect(events.map((e) => e.claimId)).toEqual(["id-1", "id-2", "id-3"]);
});

it("readEvents filters by corpusId", () => {
  const a = createSqliteAdapter();
  a.appendEvent({ op: "commit", corpusId: "corp-A", writer: "w", claimId: "c1", recorded: 1000, recordedSeq: 1 });
  a.appendEvent({ op: "commit", corpusId: "corp-B", writer: "w", claimId: "c2", recorded: 2000, recordedSeq: 2 });
  const results = a.readEvents({ corpusId: "corp-A" });
  expect(results).toHaveLength(1);
  expect(results[0].claimId).toBe("c1");
});

it("readEvents filters by claimId", () => {
  const a = createSqliteAdapter();
  a.appendEvent({ op: "commit", corpusId: "c", writer: "w", claimId: "claim-X", recorded: 1000, recordedSeq: 1 });
  a.appendEvent({ op: "commit", corpusId: "c", writer: "w", claimId: "claim-Y", recorded: 2000, recordedSeq: 2 });
  const results = a.readEvents({ claimId: "claim-X" });
  expect(results).toHaveLength(1);
  expect(results[0].claimId).toBe("claim-X");
});

it("readEvents filters by since (recorded >= since)", () => {
  const a = createSqliteAdapter();
  a.appendEvent({ op: "commit", corpusId: "c", writer: "w", claimId: "c1", recorded: 1000, recordedSeq: 1 });
  a.appendEvent({ op: "commit", corpusId: "c", writer: "w", claimId: "c2", recorded: 2000, recordedSeq: 2 });
  a.appendEvent({ op: "commit", corpusId: "c", writer: "w", claimId: "c3", recorded: 3000, recordedSeq: 3 });
  const results = a.readEvents({ since: 2000 });
  expect(results).toHaveLength(2);
  expect(results.map((e) => e.claimId).sort()).toEqual(["c2", "c3"]);
});

it("readEvents returns empty array when no events match", () => {
  const a = createSqliteAdapter();
  expect(a.readEvents()).toHaveLength(0);
  expect(a.readEvents({ corpusId: "no-such" })).toHaveLength(0);
});

it("transaction commits on normal return", () => {
  const a = createSqliteAdapter();
  const claim = makeValidatedClaim({ recordedSeq: 5 });
  a.transaction(() => {
    a.insertClaim(claim);
    a.appendEvent({ op: "commit", corpusId: "c", writer: "w", claimId: claim.id, recorded: 1000, recordedSeq: 5 });
  });
  expect(a.getClaim(claim.id)?.id).toBe(claim.id);
  expect(a.readEvents()).toHaveLength(1);
  expect(a.maxRecordedSeq()).toBe(5);
});

it("transaction rolls back all writes when fn throws", () => {
  const a = createSqliteAdapter();
  const claim = makeValidatedClaim({ recordedSeq: 99 });
  expect(() =>
    a.transaction(() => {
      a.insertClaim(claim);
      a.appendEvent({ op: "commit", corpusId: "c", writer: "w", claimId: claim.id, recorded: 1000, recordedSeq: 99 });
      throw new Error("boom");
    })
  ).toThrow();
  expect(a.maxRecordedSeq()).toBe(0);
  expect(a.readEvents()).toHaveLength(0);
});

it("transaction returns the value from fn", () => {
  const a = createSqliteAdapter();
  const result = a.transaction(() => 42);
  expect(result).toBe(42);
});

// --- scoped() adapter tests ---

it("scoped insertClaim stamps corpus_id; base insertClaim stores null corpus_id", () => {
  const a = createSqliteAdapter();
  const claimA = makeValidatedClaim({ value: "a" });
  const claimBase = makeValidatedClaim({ value: "base" });
  a.scoped!({ corpus: "A" }).insertClaim(claimA);
  a.insertClaim(claimBase);
  // scoped query for A returns only corpus-A claim
  const resultsA = a.scoped!({ corpus: "A" }).query({} as any);
  expect(resultsA).toHaveLength(1);
  expect(resultsA[0].value).toBe("a");
  // base query returns both (no corpus filter)
  const allResults = a.query({ corpusId: "any" });
  expect(allResults).toHaveLength(2);
});

it("scoped query never returns another corpus's claims", () => {
  const a = createSqliteAdapter();
  a.scoped!({ corpus: "A" }).insertClaim(makeValidatedClaim({ value: "a" }));
  a.scoped!({ corpus: "B" }).insertClaim(makeValidatedClaim({ value: "b" }));
  expect(a.scoped!({ corpus: "A" }).query({} as any)).toHaveLength(1);
  // passing corpusId:"B" to a corpus-A scope is ignored (force-injection is bypass-proof)
  expect(a.scoped!({ corpus: "A" }).query({ corpusId: "B" } as any)).toHaveLength(1);
});

it("scoped with profile filters by both corpus and profile", () => {
  const a = createSqliteAdapter();
  const claimP1 = makeValidatedClaim({ profile: "p1" as any });
  const claimP2 = makeValidatedClaim({ profile: "p2" as any });
  a.scoped!({ corpus: "A" }).insertClaim(claimP1);
  a.scoped!({ corpus: "A" }).insertClaim(claimP2);
  const results = a.scoped!({ corpus: "A", profile: "p1" }).query({} as any);
  expect(results).toHaveLength(1);
  expect(results[0].profile).toBe("p1");
});

it("scoped getClaim returns undefined for a claim from another corpus", () => {
  const a = createSqliteAdapter();
  const claimB = makeValidatedClaim({ value: "b" });
  a.scoped!({ corpus: "B" }).insertClaim(claimB);
  // corpus-A scope should not see corpus-B's claim
  expect(a.scoped!({ corpus: "A" }).getClaim(claimB.id)).toBeUndefined();
});

it("scoped getClaim returns the claim when corpus matches", () => {
  const a = createSqliteAdapter();
  const claim = makeValidatedClaim({ value: "mine" });
  a.scoped!({ corpus: "A" }).insertClaim(claim);
  expect(a.scoped!({ corpus: "A" }).getClaim(claim.id)).toBeDefined();
});

it("scoped insertBatch stamps all claims with corpus_id", () => {
  const a = createSqliteAdapter();
  const c1 = makeValidatedClaim({ value: "x" });
  const c2 = makeValidatedClaim({ value: "y" });
  a.scoped!({ corpus: "A" }).insertBatch([c1, c2]);
  expect(a.scoped!({ corpus: "A" }).query({} as any)).toHaveLength(2);
  expect(a.scoped!({ corpus: "B" }).query({} as any)).toHaveLength(0);
});

it("scoped delegates capabilities, transaction, maxRecordedSeq, and close to base", () => {
  const a = createSqliteAdapter();
  const scoped = a.scoped!({ corpus: "X" });
  // capabilities must be delegated
  const caps = scoped.capabilities();
  expect(caps.valuePredicateSupport.equality).toBe("fallback_in_memory");
  // transaction must work
  const claim = makeValidatedClaim();
  const result = scoped.transaction(() => {
    scoped.insertClaim(claim);
    return 99;
  });
  expect(result).toBe(99);
  expect(scoped.getClaim(claim.id)).toBeDefined();
  // maxRecordedSeq is delegated
  expect(typeof scoped.maxRecordedSeq()).toBe("number");
});

it("re-scoping via scoped().scoped() uses the new scope, not the outer scope", () => {
  const a = createSqliteAdapter();
  const claimA = makeValidatedClaim({ value: "in-A" });
  a.scoped!({ corpus: "A" }).insertClaim(claimA);
  // re-scope to B via A's scoped handle — should act as scope B
  const rescopedB = a.scoped!({ corpus: "A" }).scoped!({ corpus: "B" });
  expect(rescopedB.query({} as any)).toHaveLength(0);
  const claimB = makeValidatedClaim({ value: "in-B" });
  rescopedB.insertClaim(claimB);
  expect(a.scoped!({ corpus: "B" }).query({} as any)).toHaveLength(1);
});

// --- scoped deleteClaim corpus-guard tests ---

it("scoped deleteClaim does NOT deprecate a claim from another corpus (cross-corpus write is no-op)", () => {
  const a = createSqliteAdapter();
  const claimA = makeValidatedClaim({ value: "in-A" });
  a.scoped!({ corpus: "A" }).insertClaim(claimA);

  // corpus-B handle attempts to delete corpus-A's claim — must be a no-op
  a.scoped!({ corpus: "B" }).deleteClaim(claimA.id);

  // claim should still be validated in corpus A
  const fetched = a.scoped!({ corpus: "A" }).getClaim(claimA.id);
  expect(fetched).toBeDefined();
  expect(fetched!.status).toBe("validated");
});

it("scoped deleteClaim DOES deprecate a claim in the same corpus", () => {
  const a = createSqliteAdapter();
  const claimA = makeValidatedClaim({ value: "in-A" });
  a.scoped!({ corpus: "A" }).insertClaim(claimA);

  // same-corpus delete should work
  a.scoped!({ corpus: "A" }).deleteClaim(claimA.id);

  // now fetch via base (which has no corpus guard) to confirm status changed
  const fetched = a.getClaim(claimA.id);
  expect(fetched).toBeDefined();
  expect(fetched!.status).toBe("deprecated");
});

// --- Migration test: corpus_id added to pre-existing db ---

it("migration adds corpus_id to a pre-existing db without error and scoped ops work", () => {
  // Step 1: create a db file with OLD claims schema that lacks corpus_id
  const dir = mkdtempSync(join(tmpdir(), "mneme-test-"));
  const dbPath = join(dir, "legacy.db");

  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE claims (
      id TEXT PRIMARY KEY,
      profile TEXT,
      workspace TEXT,
      subject TEXT,
      key TEXT,
      scope_hash TEXT,
      scope_json TEXT,
      value_json TEXT,
      value_hash TEXT,
      conf_distribution TEXT,
      conf_params TEXT,
      conf_raw REAL,
      conf_effective REAL,
      valid_from REAL,
      valid_to REAL,
      recorded REAL,
      recorded_seq INTEGER,
      status TEXT,
      source TEXT,
      provenance_json TEXT,
      evidence_json TEXT,
      audience_json TEXT,
      tags_json TEXT,
      schema TEXT,
      run_id TEXT
    );
  `);
  legacyDb.close();

  // Step 2: createSqliteAdapter should NOT throw (migration runs idempotently)
  let adapter: ReturnType<typeof createSqliteAdapter>;
  expect(() => {
    adapter = createSqliteAdapter(dbPath);
  }).not.toThrow();

  // Step 3: scoped insert + scoped query works on the migrated db
  const claim = makeValidatedClaim({ value: "migrated-claim" });
  adapter!.scoped!({ corpus: "X" }).insertClaim(claim);
  const results = adapter!.scoped!({ corpus: "X" }).query({} as any);
  expect(results).toHaveLength(1);
  expect(results[0].value).toBe("migrated-claim");
});

it("migration backfills corpus_id from workspace so pre-existing claims survive the upgrade", () => {
  // A real legacy store (pre-corpus_id) carries the corpus in `workspace`. Without a backfill,
  // post-migration rows have corpus_id = NULL and the now-scoped facade filters them out
  // ("upgrade ate my data"). The migration must stamp corpus_id from workspace.
  const dir = mkdtempSync(join(tmpdir(), "mneme-test-"));
  const dbPath = join(dir, "legacy-backfill.db");
  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE claims (
      id TEXT PRIMARY KEY, profile TEXT, workspace TEXT, subject TEXT, key TEXT,
      scope_hash TEXT, scope_json TEXT, value_json TEXT, value_hash TEXT,
      conf_distribution TEXT, conf_params TEXT, conf_raw REAL, conf_effective REAL,
      valid_from REAL, valid_to REAL, recorded REAL, recorded_seq INTEGER,
      status TEXT, source TEXT, provenance_json TEXT, evidence_json TEXT,
      audience_json TEXT, tags_json TEXT, schema TEXT, run_id TEXT
    );
  `);
  legacyDb.prepare("INSERT INTO claims (id, workspace) VALUES (?, ?)").run("legacy-1", "tenant-a");
  legacyDb.prepare("INSERT INTO claims (id, workspace) VALUES (?, ?)").run("legacy-2", "tenant-b");
  legacyDb.close();

  createSqliteAdapter(dbPath); // migration: ADD COLUMN corpus_id + backfill from workspace

  const raw = new Database(dbPath, { readonly: true });
  const rows = raw.prepare("SELECT id, corpus_id FROM claims ORDER BY id").all();
  raw.close();
  expect(rows).toEqual([
    { id: "legacy-1", corpus_id: "tenant-a" },
    { id: "legacy-2", corpus_id: "tenant-b" },
  ]);
});

it("corpus-scoped contradiction lookup uses the composite identity index (guards O(n^2) writes)", () => {
  // The contradiction-detection query is corpus_id + subject + key + scope_hash. If SQLite falls back
  // to the corpus_id-only index it scans the whole growing corpus per insert (O(n^2)). The composite
  // idx_claims_corpus_identity must cover it as an index seek.
  const dir = mkdtempSync(join(tmpdir(), "mneme-test-"));
  const dbPath = join(dir, "plan.db");
  createSqliteAdapter(dbPath).close!(); // build schema + indexes, then release the file
  const raw = new Database(dbPath, { readonly: true });
  const plan = raw
    .prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM claims WHERE corpus_id=? AND subject=? AND key=? AND scope_hash=? AND status IN ('validated')"
    )
    .all("c", "s", "k", "h") as Array<{ detail: string }>;
  raw.close();
  expect(plan.map((p) => p.detail).join(" ")).toContain("idx_claims_corpus_identity");
});

// --- Hash-chain tests (task-events-chain) ---

it("appendEvent sets entryHash on the first event (genesis: prevHash = '')", () => {
  const a = createSqliteAdapter();
  a.appendEvent({ op: "commit", corpusId: "c1", writer: "w", claimId: "cl-1", recorded: 1000, recordedSeq: 1 });
  const evs = a.readEvents({ corpusId: "c1" });
  expect(evs).toHaveLength(1);
  expect(typeof evs[0].entryHash).toBe("string");
  expect(evs[0].entryHash!.length).toBeGreaterThan(0);
  expect(evs[0].prevHash).toBe("");
});

it("chains claim_events per corpus so consecutive events link (e[i+1].prevHash === e[i].entryHash)", () => {
  const a = createSqliteAdapter();
  a.appendEvent({ op: "commit", corpusId: "c1", writer: "w", claimId: "cl-1", recorded: 1000, recordedSeq: 1 });
  a.appendEvent({ op: "commit", corpusId: "c1", writer: "w", claimId: "cl-2", recorded: 2000, recordedSeq: 2 });
  a.appendEvent({ op: "commit", corpusId: "c1", writer: "w", claimId: "cl-3", recorded: 3000, recordedSeq: 3 });
  const evs = a.readEvents({ corpusId: "c1" });
  expect(evs).toHaveLength(3);
  expect(evs[1].prevHash).toBe(evs[0].entryHash);
  expect(evs[2].prevHash).toBe(evs[1].entryHash);
});

it("events in different corpora form independent chains (cross-corpus inserts do not affect each other's prevHash)", () => {
  const a = createSqliteAdapter();
  // Interleave events from two corpora
  a.appendEvent({ op: "commit", corpusId: "c1", writer: "w", claimId: "c1-e1", recorded: 1000, recordedSeq: 1 });
  a.appendEvent({ op: "commit", corpusId: "c2", writer: "w", claimId: "c2-e1", recorded: 1100, recordedSeq: 1 });
  a.appendEvent({ op: "commit", corpusId: "c1", writer: "w", claimId: "c1-e2", recorded: 2000, recordedSeq: 2 });
  a.appendEvent({ op: "commit", corpusId: "c2", writer: "w", claimId: "c2-e2", recorded: 2100, recordedSeq: 2 });

  const c1evs = a.readEvents({ corpusId: "c1" });
  const c2evs = a.readEvents({ corpusId: "c2" });

  // Each chain must link internally
  expect(c1evs[1].prevHash).toBe(c1evs[0].entryHash);
  expect(c2evs[1].prevHash).toBe(c2evs[0].entryHash);

  // The two chains' hashes must be distinct (independent)
  expect(c1evs[0].entryHash).not.toBe(c2evs[0].entryHash);
});

it("entryHash is deterministic: sha256(canon(event) + prevHash)", () => {
  // Two adapters inserting identical events should produce identical hashes
  const a = createSqliteAdapter();
  const b = createSqliteAdapter();
  const ev = { op: "commit" as const, corpusId: "c1", writer: "w", claimId: "cl-1", recorded: 1000, recordedSeq: 1 };
  a.appendEvent(ev);
  b.appendEvent(ev);
  const aHash = a.readEvents({ corpusId: "c1" })[0].entryHash;
  const bHash = b.readEvents({ corpusId: "c1" })[0].entryHash;
  expect(aHash).toBe(bHash);
});

// --- AnchoredRoot tests ---

it("putAnchoredRoot / getAnchoredRoots round-trips a root row scoped by corpusId", () => {
  const a = createSqliteAdapter();
  const row: AnchoredRootRow = {
    corpusId: "c1",
    epochId: "epoch-1",
    root: "deadbeef1234",
    signature: "sig-abc",
    guarantee: "sha256-merkle",
    at: 1716000000000,
  };
  a.putAnchoredRoot!(row);
  const results = a.getAnchoredRoots!("c1");
  expect(results).toHaveLength(1);
  expect(results[0]).toEqual(row);
});

it("getAnchoredRoots is scoped: another corpus sees no rows", () => {
  const a = createSqliteAdapter();
  a.putAnchoredRoot!({ corpusId: "c1", epochId: "e1", root: "r1", signature: null, guarantee: "g", at: 1 });
  expect(a.getAnchoredRoots!("c2")).toHaveLength(0);
});

it("getAnchoredRoots filters by epochId when supplied", () => {
  const a = createSqliteAdapter();
  a.putAnchoredRoot!({ corpusId: "c1", epochId: "e1", root: "r1", signature: null, guarantee: "g", at: 1 });
  a.putAnchoredRoot!({ corpusId: "c1", epochId: "e2", root: "r2", signature: null, guarantee: "g", at: 2 });
  const results = a.getAnchoredRoots!("c1", { epochId: "e1" });
  expect(results).toHaveLength(1);
  expect(results[0].epochId).toBe("e1");
});

it("getAnchoredRoots filters by since when supplied", () => {
  const a = createSqliteAdapter();
  a.putAnchoredRoot!({ corpusId: "c1", epochId: "e1", root: "r1", signature: null, guarantee: "g", at: 1000 });
  a.putAnchoredRoot!({ corpusId: "c1", epochId: "e2", root: "r2", signature: null, guarantee: "g", at: 2000 });
  a.putAnchoredRoot!({ corpusId: "c1", epochId: "e3", root: "r3", signature: null, guarantee: "g", at: 3000 });
  const results = a.getAnchoredRoots!("c1", { since: 2000 });
  expect(results).toHaveLength(2);
  expect(results.map((r) => r.epochId).sort()).toEqual(["e2", "e3"]);
});

it("two genesis events identical except reason produce distinct entryHash", () => {
  const a = createSqliteAdapter();
  const b = createSqliteAdapter();
  const base = { op: "promote" as const, corpusId: "c1", writer: "w", claimId: "cl-1", toStatus: "validated", recorded: 1000, recordedSeq: 1 };
  a.appendEvent({ ...base, reason: "reason-A" });
  b.appendEvent({ ...base, reason: "reason-B" });
  const aHash = a.readEvents({ corpusId: "c1" })[0].entryHash;
  const bHash = b.readEvents({ corpusId: "c1" })[0].entryHash;
  expect(aHash).not.toBe(bHash);
});

it("putAnchoredRoot is idempotent (INSERT OR REPLACE)", () => {
  const a = createSqliteAdapter();
  a.putAnchoredRoot!({ corpusId: "c1", epochId: "e1", root: "r1", signature: null, guarantee: "g", at: 1 });
  a.putAnchoredRoot!({ corpusId: "c1", epochId: "e1", root: "r1-updated", signature: "sig", guarantee: "g2", at: 2 });
  const results = a.getAnchoredRoots!("c1");
  expect(results).toHaveLength(1);
  expect(results[0].root).toBe("r1-updated");
});

// --- Migration test: entry_hash/prev_hash added to pre-existing db ---

it("scoped read carries the enforced corpusId; base read leaves it absent (never workspace)", () => {
  const a = createSqliteAdapter();
  const scoped = a.scoped!({ corpus: "corpus-x" });
  // workspace deliberately != corpus to prove corpusId is not workspace-derived
  const scopedClaim = makeValidatedClaim({ workspace: "ws-other" as WorkspaceId });
  scoped.insertClaim(scopedClaim);
  expect(scoped.getClaim(scopedClaim.id)!.corpusId).toBe("corpus-x");

  const baseClaim = makeValidatedClaim({ workspace: "ws-other" as WorkspaceId });
  a.insertClaim(baseClaim);
  expect(a.getClaim(baseClaim.id)!.corpusId).toBeUndefined();
});

it("migration adds entry_hash/prev_hash columns and audit_anchors table to a pre-existing db without error", () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-chain-test-"));
  const dbPath = join(dir, "legacy-events.db");

  // Create a db that already has claim_events WITHOUT the new columns
  const legacyDb = new Database(dbPath);
  legacyDb.exec(`
    CREATE TABLE claims (
      id TEXT PRIMARY KEY,
      profile TEXT, workspace TEXT, subject TEXT, key TEXT,
      scope_hash TEXT, scope_json TEXT, value_json TEXT, value_hash TEXT,
      conf_distribution TEXT, conf_params TEXT, conf_raw REAL, conf_effective REAL,
      valid_from REAL, valid_to REAL, recorded REAL, recorded_seq INTEGER,
      status TEXT, source TEXT, provenance_json TEXT, evidence_json TEXT,
      audience_json TEXT, tags_json TEXT, schema TEXT, run_id TEXT
    );
    CREATE TABLE claim_events (
      seq_pk INTEGER PRIMARY KEY AUTOINCREMENT,
      op TEXT, corpus_id TEXT, writer TEXT, claim_id TEXT,
      deprecated_id TEXT, to_status TEXT, reason TEXT,
      recorded REAL, recorded_seq INTEGER
    );
  `);
  legacyDb.close();

  // createSqliteAdapter must not throw
  let adapter: ReturnType<typeof createSqliteAdapter>;
  expect(() => {
    adapter = createSqliteAdapter(dbPath);
  }).not.toThrow();

  // Should be able to append events with hashes
  adapter!.appendEvent({ op: "commit", corpusId: "c1", writer: "w", claimId: "cl-1", recorded: 1000, recordedSeq: 1 });
  const evs = adapter!.readEvents({ corpusId: "c1" });
  expect(evs).toHaveLength(1);
  expect(typeof evs[0].entryHash).toBe("string");

  // Should be able to use anchor store
  adapter!.putAnchoredRoot!({ corpusId: "c1", epochId: "e1", root: "r1", signature: null, guarantee: "g", at: 1 });
  expect(adapter!.getAnchoredRoots!("c1")).toHaveLength(1);
});
