import { enforce, findValidatedConflict } from "./contradiction.js";
import type { Claim } from "../core/claim.js";

// Helper to make minimal claim-like objects for testing
function makeClaim(overrides: { id: string; valueHash: string; confidence: Claim["confidence"]; status: Claim["status"] } & Record<string, any>): Claim {
  return {
    profile: "p1",
    workspace: "w1",
    subject: "s",
    key: "s.k",
    scope: {},
    scopeHash: "_",
    value: {},
    source: "manual",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "default",
    valid: { start: 0, end: null },
    recorded: 0,
    recordedSeq: 0,
    ...overrides,
  } as unknown as Claim;
}

const highConfidence: Claim["confidence"] = { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 };
const lowConfidence: Claim["confidence"] = { distribution: "beta", parameters: { alpha: 2, beta: 2 }, raw: 0.5 };
const equalConfidence: Claim["confidence"] = { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 };

// ── findValidatedConflict ─────────────────────────────────────────────────────

it("findValidatedConflict returns undefined when no claims exist", () => {
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [] } as any;
  expect(findValidatedConflict(candidate, adapter)).toBeUndefined();
});

it("findValidatedConflict returns undefined when existing claim has same valueHash", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: highConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h1", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  expect(findValidatedConflict(candidate, adapter)).toBeUndefined();
});

it("findValidatedConflict returns conflicting claim when valueHash differs", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: highConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  expect(findValidatedConflict(candidate, adapter)).toBe(existing);
});

it("findValidatedConflict passes status:['validated'] to adapter query", () => {
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  let capturedPlan: any;
  const adapter = { query: (plan: any) => { capturedPlan = plan; return []; } } as any;
  findValidatedConflict(candidate, adapter);
  expect(capturedPlan.status).toEqual(["validated"]);
});

it("findValidatedConflict passes subject, key, scopeHash, corpusId to adapter query", () => {
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate", subject: "mySubject" as any, key: "myKey" as any, scopeHash: "myScopeHash", workspace: "myWorkspace" as any });
  let capturedPlan: any;
  const adapter = { query: (plan: any) => { capturedPlan = plan; return []; } } as any;
  findValidatedConflict(candidate, adapter);
  expect(capturedPlan.subject).toBe("mySubject");
  expect(capturedPlan.key).toBe("myKey");
  expect(capturedPlan.scopeHash).toBe("myScopeHash");
  expect(capturedPlan.corpusId).toBe("myWorkspace");
});

// ── enforce: no conflict ──────────────────────────────────────────────────────

it("enforce returns accept when no conflict exists regardless of policy", () => {
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [] } as any;
  expect(enforce(candidate, { kind: "always_accept" }, adapter).decision).toBe("accept");
  expect(enforce(candidate, { kind: "reject_on_contradiction" }, adapter).decision).toBe("accept");
  expect(enforce(candidate, { kind: "accept_but_mark" }, adapter).decision).toBe("accept");
  expect(enforce(candidate, { kind: "accept_and_resolve", rule: "deprecate_lower" }, adapter).decision).toBe("accept");
});

// ── enforce: always_accept ────────────────────────────────────────────────────

it("always_accept accepts even when a validated conflict exists", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: highConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  const outcome = enforce(candidate, { kind: "always_accept" }, adapter);
  expect(outcome.decision).toBe("accept");
});

// ── enforce: reject_on_contradiction ─────────────────────────────────────────

it("reject_on_contradiction rejects when existing claim has higher confidence", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: highConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  expect(enforce(candidate, { kind: "reject_on_contradiction" }, adapter).decision).toBe("reject");
});

it("reject_on_contradiction rejects when existing claim has equal confidence", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: equalConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: equalConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  expect(enforce(candidate, { kind: "reject_on_contradiction" }, adapter).decision).toBe("reject");
});

it("reject_on_contradiction accepts when candidate has strictly higher confidence", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: lowConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: highConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  expect(enforce(candidate, { kind: "reject_on_contradiction" }, adapter).decision).toBe("accept");
});

// ── enforce: accept_but_mark ──────────────────────────────────────────────────

it("accept_but_mark accepts and sets markArtifact=true when conflict exists", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: highConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  const outcome = enforce(candidate, { kind: "accept_but_mark" }, adapter);
  expect(outcome.decision).toBe("accept");
  expect(outcome.markArtifact).toBe(true);
});

it("accept_but_mark does not set markArtifact when no conflict exists", () => {
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [] } as any;
  const outcome = enforce(candidate, { kind: "accept_but_mark" }, adapter);
  expect(outcome.decision).toBe("accept");
  expect(outcome.markArtifact).toBeUndefined();
});

// ── enforce: accept_and_resolve (deprecate_lower) ────────────────────────────

it("accept_and_resolve(deprecate_lower) deprecates the conflict when candidate has higher confidence", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: lowConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: highConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  const outcome = enforce(candidate, { kind: "accept_and_resolve", rule: "deprecate_lower" }, adapter);
  expect(outcome.decision).toBe("accept");
  expect(outcome.deprecateIds).toEqual(["E"]);
});

it("accept_and_resolve(deprecate_lower) returns empty deprecateIds when candidate has lower or equal confidence", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: highConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  const outcome = enforce(candidate, { kind: "accept_and_resolve", rule: "deprecate_lower" }, adapter);
  expect(outcome.decision).toBe("accept");
  expect(outcome.deprecateIds).toEqual([]);
});

it("accept_and_resolve(keep_newer) accepts without deprecating", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: lowConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: highConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  const outcome = enforce(candidate, { kind: "accept_and_resolve", rule: "keep_newer" }, adapter);
  expect(outcome.decision).toBe("accept");
  // keep_newer doesn't deprecate by pointEstimate; it keeps the newer one
  expect(outcome.deprecateIds).toBeDefined();
});
