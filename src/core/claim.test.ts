import type { Claim, CandidateClaim, Status, Source } from "./claim.js";

it("a fully-populated claim satisfies the Claim shape", () => {
  const c: Claim = {
    id: "id-1" as import("./ids.js").ClaimId,
    profile: "p" as import("./ids.js").ProfileId,
    workspace: "w" as import("./ids.js").WorkspaceId,
    subject: "person",
    key: "person.name",
    scope: {},
    scopeHash: "abc123",
    value: "Alice",
    valueHash: "def456",
    confidence: { distribution: "scalar", parameters: { p: 0.9 }, raw: 0.9 },
    valid: { from: 0, to: Number.POSITIVE_INFINITY },
    recorded: Date.now(),
    recordedSeq: 1,
    status: "validated",
    source: "manual",
    provenance: {},
    evidence: [],
    audience: {},
    tags: [],
    schema: "text",
  };
  expect(c.status).toBe("validated");
});

it("Status type accepts all valid values", () => {
  const statuses: Status[] = ["candidate", "provisional", "validated", "deprecated"];
  expect(statuses).toHaveLength(4);
});

it("Source type accepts all valid values", () => {
  const sources: Source[] = ["manual", "verification", "workflow", "heuristic", "llm", "imported"];
  expect(sources).toHaveLength(6);
});

it("CandidateClaim omits library-assigned fields and makes status optional", () => {
  // This is a compile-time check via a typed literal.
  // A CandidateClaim must NOT require id, recorded, recordedSeq, scopeHash, valueHash.
  // status is optional.
  const candidate: CandidateClaim = {
    profile: "p" as import("./ids.js").ProfileId,
    workspace: "w" as import("./ids.js").WorkspaceId,
    subject: "person",
    key: "person.name",
    scope: {},
    value: "Alice",
    confidence: {
      distribution: "scalar",
      parameters: { p: 0.9 },
      raw: 0.9,
    },
    valid: { from: 0, to: Number.POSITIVE_INFINITY },
    source: "manual",
    provenance: {},
    evidence: [],
    tags: [],
    schema: "text",
  };

  expect(candidate.profile).toBe("p");
  // status is optional so should be undefined when not set
  expect(candidate.status).toBeUndefined();
});

it("CandidateClaim allows optional status to be set", () => {
  const candidate: CandidateClaim = {
    profile: "p" as import("./ids.js").ProfileId,
    workspace: "w" as import("./ids.js").WorkspaceId,
    subject: "person",
    key: "person.name",
    scope: {},
    value: "Bob",
    confidence: {
      distribution: "scalar",
      parameters: { p: 0.7 },
      raw: 0.7,
    },
    valid: { from: 0, to: Number.POSITIVE_INFINITY },
    source: "llm",
    provenance: { workflow: "infer" },
    evidence: [],
    tags: ["ai-generated"],
    schema: "text",
    status: "candidate",
  };

  expect(candidate.status).toBe("candidate");
});
