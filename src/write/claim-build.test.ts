import { describe, it, expect } from "vitest";
import {
  buildCommittedClaim,
  contradictionArtifact,
  buildCommitEvent,
  buildSupersedeEvent,
  buildPromoteEvent,
} from "./claim-build.js";
import type { Claim } from "../core/claim.js";

const baseClaim: Claim = {
  id: "c1" as any,
  profile: "p" as any,
  workspace: "w" as any,
  subject: "repo" as any,
  key: "repo.x" as any,
  scope: {},
  scopeHash: "sh1",
  value: 1,
  valueHash: "vh1",
  confidence: { distribution: "beta", parameters: { alpha: 9, beta: 1 }, raw: 0.9 } as any,
  valid: { start: 0 } as any,
  recorded: 0,
  recordedSeq: 0,
  status: "validated",
  source: "manual",
  provenance: { runId: "t1" },
  evidence: [],
  audience: {},
  tags: [],
  schema: "v1",
};

describe("buildCommittedClaim", () => {
  it("overlays recorded and recordedSeq onto the candidate, keeping other fields", () => {
    const candidateForEnforce = { ...baseClaim, recorded: 0, recordedSeq: 0 };
    const claim = buildCommittedClaim(candidateForEnforce, 100, 7);
    expect(claim.recorded).toBe(100);
    expect(claim.recordedSeq).toBe(7);
    expect(claim.id).toBe(candidateForEnforce.id);
    expect(claim.subject).toBe(candidateForEnforce.subject);
    expect(claim.value).toBe(candidateForEnforce.value);
  });
});

describe("contradictionArtifact", () => {
  it("carries the conflicting pair and validated status", () => {
    const accepted: Claim = { ...baseClaim, id: "accepted-id" as any };
    const art = contradictionArtifact(accepted, "conflict-id", 100, 7);
    expect(art.value).toEqual({ leftId: accepted.id, rightId: "conflict-id" });
    expect(art.status).toBe("validated");
  });

  it("stamps subject/key as the reserved contradiction-mark, uses accepted's scope, recorded/seq", () => {
    const accepted: Claim = { ...baseClaim, id: "accepted-id" as any, scope: { project: "x" } as any, scopeHash: "shx" };
    const art = contradictionArtifact(accepted, "conflict-id", 555, 9);
    expect(art.subject).toBe("contradiction");
    expect(art.key).toBe("contradiction.mark");
    expect(art.scope).toEqual(accepted.scope);
    expect(art.scopeHash).toBe(accepted.scopeHash);
    expect(art.recorded).toBe(555);
    expect(art.recordedSeq).toBe(9);
    expect(art.source).toBe("verification");
    expect(art.schema).toBe("contradiction-mark-v1");
    expect(art.id).not.toBe(accepted.id);
  });

  it("propagates corpusId only when the accepted claim has one", () => {
    const withCorpus: Claim = { ...baseClaim, corpusId: "corp1" as any };
    const art = contradictionArtifact(withCorpus, "conflict-id", 1, 1);
    expect(art.corpusId).toBe("corp1");

    const withoutCorpus: Claim = { ...baseClaim };
    delete (withoutCorpus as any).corpusId;
    const art2 = contradictionArtifact(withoutCorpus, "conflict-id", 1, 1);
    expect(art2.corpusId).toBeUndefined();
  });
});

describe("buildCommitEvent", () => {
  it("builds a commit-op event with the given fields", () => {
    const event = buildCommitEvent("corp1", "writer1", "claim1", 42, 3);
    expect(event).toEqual({
      op: "commit",
      corpusId: "corp1",
      writer: "writer1",
      claimId: "claim1",
      recorded: 42,
      recordedSeq: 3,
    });
  });
});

describe("buildSupersedeEvent", () => {
  it("builds a supersede-op event carrying the deprecated id", () => {
    const event = buildSupersedeEvent("corp1", "writer1", "newId", "oldId", 42, 3);
    expect(event).toEqual({
      op: "supersede",
      corpusId: "corp1",
      writer: "writer1",
      claimId: "newId",
      deprecatedId: "oldId",
      recorded: 42,
      recordedSeq: 3,
    });
  });
});

describe("buildPromoteEvent", () => {
  it("builds a promote-op event carrying toStatus and reason", () => {
    const event = buildPromoteEvent("corp1", "writer1", "claim1", "validated", "because", 42, 3);
    expect(event).toEqual({
      op: "promote",
      corpusId: "corp1",
      writer: "writer1",
      claimId: "claim1",
      toStatus: "validated",
      reason: "because",
      recorded: 42,
      recordedSeq: 3,
    });
  });

  it("omits reason from equality when undefined but still sets the key", () => {
    const event = buildPromoteEvent("corp1", "writer1", "claim1", "validated", undefined, 42, 3);
    expect(event.reason).toBeUndefined();
    expect(event.toStatus).toBe("validated");
  });
});
