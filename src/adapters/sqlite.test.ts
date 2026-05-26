import { createSqliteAdapter } from "./sqlite.js";
import type { Claim } from "../core/claim.js";
import type { ClaimId, ProfileId, WorkspaceId } from "../core/ids.js";

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

it("capabilities returns all predicateKinds as native_unindexed", () => {
  const a = createSqliteAdapter();
  const caps = a.capabilities();
  const kinds = ["equality", "range", "set_membership", "regex", "structural_pattern", "null_check"] as const;
  for (const kind of kinds) {
    expect(caps.valuePredicateSupport[kind]).toBe("native_unindexed");
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
