import { admitSummaries } from "./summarize-admit.js";
import { SUMMARY_WORKFLOW } from "./summarize-types.js";

it("admits a valid proposal as a marked, runId-tagged derive and drops unknown cites", () => {
  const selected = [{ id: "x" }] as any[];
  const ep = { id: "e", runIds: ["r1"], startedAt: 0 } as any;
  const good = { key: "session.digest", value: "…", cites: ["x"] } as any;
  const bad = { key: "bad", value: "…", cites: ["nope"] } as any;
  const { ops, dropped } = admitSummaries([good, bad], selected, ep, 1000 as any, { modelVersion: "m1" });
  expect(ops).toHaveLength(1);
  expect((ops[0] as any).kind).toBe("derive");
  const claim = (ops[0] as any).claim;
  expect(claim.provenance.workflow).toBe(SUMMARY_WORKFLOW);
  expect(claim.provenance.runId).toBe("r1");
  expect(dropped).toHaveLength(1);
});

it("produces a CandidateClaim with status candidate, source llm, and correct confidence", () => {
  const selected = [{ id: "a", profile: "p1", workspace: "w1", valid: { from: 0 }, schema: "s1" }] as any[];
  const ep = { id: "e2", runIds: ["r2"], startedAt: 0 } as any;
  const proposal = { key: "topic.summary", value: "some text", cites: ["a"], rationale: "because" } as any;
  const { ops, dropped } = admitSummaries([proposal], selected, ep, 2000 as any, { modelVersion: "v2" });
  expect(dropped).toHaveLength(0);
  expect(ops).toHaveLength(1);
  const claim = (ops[0] as any).claim;
  expect(claim.status).toBe("candidate");
  expect(claim.source).toBe("llm");
  expect(claim.confidence.distribution).toBe("beta");
  expect(claim.confidence.parameters.alpha).toBe(1);
  expect(claim.confidence.parameters.beta).toBe(3);
  expect(claim.provenance.derivedFrom.inputClaims).toEqual(["a"]);
  expect(claim.provenance.derivedFrom.combinationRule).toBe("summary@v2");
  expect(claim.evidence).toEqual([{ kind: "claim", claimId: "a" }]);
});

it("drops proposals with empty cites", () => {
  const selected = [{ id: "z" }] as any[];
  const ep = { id: "e3", runIds: ["r3"], startedAt: 0 } as any;
  const empty = { key: "no.cites", value: "text", cites: [] } as any;
  const { ops, dropped } = admitSummaries([empty], selected, ep, 0 as any);
  expect(ops).toHaveLength(0);
  expect(dropped).toHaveLength(1);
  expect(dropped[0].reason).toBe("cites not in selected set");
});

it("drops proposals where some cites are not in selected", () => {
  const selected = [{ id: "present" }] as any[];
  const ep = { id: "e4", runIds: ["r4"], startedAt: 0 } as any;
  const partial = { key: "partial.cites", value: "text", cites: ["present", "missing"] } as any;
  const { ops, dropped } = admitSummaries([partial], selected, ep, 0 as any);
  expect(ops).toHaveLength(0);
  expect(dropped).toHaveLength(1);
});

it("uses custom prior from opts when provided", () => {
  const selected = [{ id: "b", profile: "p2", workspace: "w2", valid: { from: 0 }, schema: "s2" }] as any[];
  const ep = { id: "e5", runIds: ["r5"], startedAt: 0 } as any;
  const proposal = { key: "custom.prior", value: "text", cites: ["b"] } as any;
  const customPrior = { alpha: 2, beta: 5 };
  const { ops } = admitSummaries([proposal], selected, ep, 0 as any, { prior: customPrior });
  const claim = (ops[0] as any).claim;
  expect(claim.confidence.parameters.alpha).toBe(2);
  expect(claim.confidence.parameters.beta).toBe(5);
});

it("uses unknown modelVersion when none provided", () => {
  const selected = [{ id: "c", profile: "p3", workspace: "w3", valid: { from: 0 }, schema: "s3" }] as any[];
  const ep = { id: "e6", runIds: ["r6"], startedAt: 0 } as any;
  const proposal = { key: "no.model", value: "text", cites: ["c"] } as any;
  const { ops } = admitSummaries([proposal], selected, ep, 0 as any);
  const claim = (ops[0] as any).claim;
  expect(claim.provenance.derivedFrom.combinationRule).toBe("summary@unknown");
});

it("drops proposals with a malformed key (no dot-segment) with reason 'invalid key'", () => {
  const selected = [{ id: "d" }] as any[];
  const ep = { id: "e7", runIds: ["r7"], startedAt: 0 } as any;
  const malformed = { key: "INVALID_KEY_NO_DOT", value: "text", cites: ["d"] } as any;
  const { ops, dropped } = admitSummaries([malformed], selected, ep, 0 as any);
  expect(ops).toHaveLength(0);
  expect(dropped).toHaveLength(1);
  expect(dropped[0].reason).toBe("invalid key");
  expect(dropped[0].key).toBe("INVALID_KEY_NO_DOT");
});

it("drops all proposals when episode.runIds is empty", () => {
  const selected = [{ id: "e" }] as any[];
  const ep = { id: "e8", runIds: [], startedAt: 0 } as any;
  const p1 = { key: "topic.summary", value: "text", cites: ["e"] } as any;
  const p2 = { key: "another.summary", value: "text2", cites: ["e"] } as any;
  const { ops, dropped } = admitSummaries([p1, p2], selected, ep, 0 as any);
  expect(ops).toHaveLength(0);
  expect(dropped).toHaveLength(2);
  expect(dropped[0].reason).toBe("episode has no runIds");
  expect(dropped[1].reason).toBe("episode has no runIds");
});
