import { enforce, findValidatedConflict, decideContradiction } from "./contradiction.js";
import type { Claim } from "../core/claim.js";
import { asCorpusId } from "../core/ids.js";
import { scalarConfidence } from "../core/confidence.js";

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
  expect(findValidatedConflict(candidate, adapter, "corp")).toBeUndefined();
});

it("findValidatedConflict returns undefined when existing claim has same valueHash", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: highConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h1", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  expect(findValidatedConflict(candidate, adapter, "corp")).toBeUndefined();
});

it("findValidatedConflict returns conflicting claim when valueHash differs", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: highConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  expect(findValidatedConflict(candidate, adapter, "corp")).toBe(existing);
});

it("findValidatedConflict passes status:['validated'] to adapter query", () => {
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  let capturedPlan: any;
  const adapter = { query: (plan: any) => { capturedPlan = plan; return []; } } as any;
  findValidatedConflict(candidate, adapter, "corp");
  expect(capturedPlan.status).toEqual(["validated"]);
});

it("findValidatedConflict queries the passed corpusId, NOT candidate.workspace (isolation)", () => {
  // workspace is intentionally DIFFERENT from the enforced corpus — the query must scope by
  // the explicit corpusId so a decoupled workspace can't redirect contradiction detection.
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate", subject: "mySubject" as any, key: "myKey" as any, scopeHash: "myScopeHash", workspace: "myWorkspace" as any });
  let capturedPlan: any;
  const adapter = { query: (plan: any) => { capturedPlan = plan; return []; } } as any;
  findValidatedConflict(candidate, adapter, "enforcedCorpus");
  expect(capturedPlan.subject).toBe("mySubject");
  expect(capturedPlan.key).toBe("myKey");
  expect(capturedPlan.scopeHash).toBe("myScopeHash");
  expect(capturedPlan.corpusId).toBe("enforcedCorpus");
});

// ── enforce: no conflict ──────────────────────────────────────────────────────

it("enforce returns accept when no conflict exists regardless of policy", () => {
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [] } as any;
  expect(enforce(candidate, { kind: "always_accept" }, adapter, "corp").decision).toBe("accept");
  expect(enforce(candidate, { kind: "reject_on_contradiction" }, adapter, "corp").decision).toBe("accept");
  expect(enforce(candidate, { kind: "accept_but_mark" }, adapter, "corp").decision).toBe("accept");
  expect(enforce(candidate, { kind: "accept_and_resolve", rule: "deprecate_lower" }, adapter, "corp").decision).toBe("accept");
});

// ── enforce: always_accept ────────────────────────────────────────────────────

it("always_accept accepts even when a validated conflict exists", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: highConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  const outcome = enforce(candidate, { kind: "always_accept" }, adapter, "corp");
  expect(outcome.decision).toBe("accept");
});

// ── enforce: reject_on_contradiction ─────────────────────────────────────────

it("reject_on_contradiction rejects when existing claim has higher confidence", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: highConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  expect(enforce(candidate, { kind: "reject_on_contradiction" }, adapter, "corp").decision).toBe("reject");
});

it("reject_on_contradiction rejects when existing claim has equal confidence", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: equalConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: equalConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  expect(enforce(candidate, { kind: "reject_on_contradiction" }, adapter, "corp").decision).toBe("reject");
});

it("reject_on_contradiction accepts when candidate has strictly higher confidence", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: lowConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: highConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  expect(enforce(candidate, { kind: "reject_on_contradiction" }, adapter, "corp").decision).toBe("accept");
});

// ── enforce: accept_but_mark ──────────────────────────────────────────────────

it("accept_but_mark accepts and sets markArtifact=true when conflict exists", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: highConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  const outcome = enforce(candidate, { kind: "accept_but_mark" }, adapter, "corp");
  expect(outcome.decision).toBe("accept");
  expect(outcome.markArtifact).toBe(true);
});

it("accept_but_mark does not set markArtifact when no conflict exists", () => {
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [] } as any;
  const outcome = enforce(candidate, { kind: "accept_but_mark" }, adapter, "corp");
  expect(outcome.decision).toBe("accept");
  expect(outcome.markArtifact).toBeUndefined();
});

// ── enforce: accept_and_resolve (deprecate_lower) ────────────────────────────

it("accept_and_resolve(deprecate_lower) deprecates the conflict when candidate has higher confidence", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: lowConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: highConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  const outcome = enforce(candidate, { kind: "accept_and_resolve", rule: "deprecate_lower" }, adapter, "corp");
  expect(outcome.decision).toBe("accept");
  expect(outcome.deprecateIds).toEqual(["E"]);
});

it("accept_and_resolve(deprecate_lower) returns empty deprecateIds when candidate has lower or equal confidence", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: highConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  const outcome = enforce(candidate, { kind: "accept_and_resolve", rule: "deprecate_lower" }, adapter, "corp");
  expect(outcome.decision).toBe("accept");
  expect(outcome.deprecateIds).toEqual([]);
});

it("accept_and_resolve(keep_newer) accepts without deprecating", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: lowConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: highConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  const outcome = enforce(candidate, { kind: "accept_and_resolve", rule: "keep_newer" }, adapter, "corp");
  expect(outcome.decision).toBe("accept");
  // keep_newer doesn't deprecate by pointEstimate; it keeps the newer one
  expect(outcome.deprecateIds).toBeDefined();
});

// ── findValidatedConflict: corpus mismatch guard ──────────────────────────────

it("findValidatedConflict throws when candidate.corpusId disagrees with the enforced corpusId", () => {
  const candidate = makeClaim({ id: "c1", valueHash: "v", confidence: scalarConfidence(1), status: "candidate", corpusId: asCorpusId("corpus-a") });
  const adapter = { query: () => [] } as any;
  expect(() => findValidatedConflict(candidate, adapter, "corpus-b")).toThrow(/corpus mismatch/);
});

it("findValidatedConflict allows an absent or matching candidate corpusId", () => {
  const adapter = { query: () => [] } as any;
  const matching = makeClaim({ id: "c2", valueHash: "v", confidence: scalarConfidence(1), status: "candidate", corpusId: asCorpusId("corpus-a") });
  expect(() => findValidatedConflict(matching, adapter, "corpus-a")).not.toThrow();
  const absent = makeClaim({ id: "c3", valueHash: "v", confidence: scalarConfidence(1), status: "candidate" }); // no corpusId
  expect(() => findValidatedConflict(absent, adapter, "corpus-a")).not.toThrow();
});

// ── decideContradiction: pure decision, no I/O ────────────────────────────────

it("decideContradiction is a pure function that takes already-loaded existing claims (no adapter)", () => {
  // Golden case lifted from "reject_on_contradiction rejects when existing claim has higher confidence"
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: highConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const outcome = decideContradiction(candidate, [existing], { kind: "reject_on_contradiction" }, "corp");
  expect(outcome.decision).toBe("reject");
});

it("decideContradiction: reject_incoming keeps the existing validated conflict", () => {
  // "reject_incoming" golden case per the task's illustrative example, mapped onto the
  // real policy kind (reject_on_contradiction) with equal confidence so the existing wins.
  const validatedA = makeClaim({ id: "A", valueHash: "h1", confidence: equalConfidence, status: "validated" });
  const candidateB = makeClaim({ id: "B", valueHash: "h2", confidence: equalConfidence, status: "candidate" });
  const out = decideContradiction(candidateB, [validatedA], { kind: "reject_on_contradiction" }, "corp");
  expect(out.decision).toBe("reject");
});

it("decideContradiction returns accept when no claim in existing conflicts (same valueHash filtered out)", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: highConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h1", confidence: lowConfidence, status: "candidate" });
  const outcome = decideContradiction(candidate, [existing], { kind: "reject_on_contradiction" }, "corp");
  expect(outcome.decision).toBe("accept");
});

it("decideContradiction accepts when existing is empty, regardless of policy", () => {
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  expect(decideContradiction(candidate, [], { kind: "always_accept" }, "corp").decision).toBe("accept");
  expect(decideContradiction(candidate, [], { kind: "reject_on_contradiction" }, "corp").decision).toBe("accept");
});

it("decideContradiction throws on corpus mismatch, mirroring findValidatedConflict's guard", () => {
  const candidate = makeClaim({ id: "c1", valueHash: "v", confidence: scalarConfidence(1), status: "candidate", corpusId: asCorpusId("corpus-a") });
  expect(() => decideContradiction(candidate, [], { kind: "always_accept" }, "corpus-b")).toThrow(/corpus mismatch/);
});

it("decideContradiction accept_but_mark sets conflictId to the conflicting existing claim's id", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: highConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: lowConfidence, status: "candidate" });
  const outcome = decideContradiction(candidate, [existing], { kind: "accept_but_mark" }, "corp");
  expect(outcome.decision).toBe("accept");
  expect(outcome.markArtifact).toBe(true);
  expect(outcome.conflictId).toBe("E");
});

it("enforce delegates to decideContradiction: same outcome as calling it directly with the queried claims", () => {
  const existing = makeClaim({ id: "E", valueHash: "h1", confidence: lowConfidence, status: "validated" });
  const candidate = makeClaim({ id: "C", valueHash: "h2", confidence: highConfidence, status: "candidate" });
  const adapter = { query: () => [existing] } as any;
  const viaEnforce = enforce(candidate, { kind: "accept_and_resolve", rule: "deprecate_lower" }, adapter, "corp");
  const viaDecide = decideContradiction(candidate, [existing], { kind: "accept_and_resolve", rule: "deprecate_lower" }, "corp");
  expect(viaEnforce).toEqual(viaDecide);
});
