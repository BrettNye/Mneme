import { admitInsights } from "./dreaming-admit.js";
import type { Claim } from "../../core/claim.js";
import { DREAM_PRIOR, DREAM_WORKFLOW } from "./dreaming-types.js";
import type { ClaimSchema } from "../../catalog/schema.js";

// Helper to build a minimal Claim for tests
function makeClaim(id: string, tags: string[] = []): Claim {
  return {
    id: id as any,
    profile: "p1" as any,
    workspace: "w1" as any,
    subject: "lesson",
    key: `lesson.x-${id}`,
    scope: {},
    scopeHash: "sh",
    value: { text: "some text" },
    valueHash: "vh",
    confidence: { distribution: "beta", parameters: { alpha: 1, beta: 1 }, raw: 0.5 },
    valid: { from: 0, to: Infinity },
    recorded: 0,
    recordedSeq: 0,
    status: "validated",
    source: "manual",
    provenance: {},
    evidence: [],
    tags,
    schema: "1.0",
  } as unknown as Claim;
}

it("drops an insight that cites an id not in the selected set", () => {
  const selected = [makeClaim("g1")];
  const res = admitInsights(
    [{ key: "lesson.x", value: { text: "v" }, cites: ["nope" as any] }],
    selected,
    1,
    "m1"
  );
  expect(res.ops).toHaveLength(0);
  expect(res.dropped[0].reason).toMatch(/cites/);
});

it("drops an insight with empty cites", () => {
  const selected = [makeClaim("g1")];
  const res = admitInsights(
    [{ key: "lesson.x", value: { text: "v" }, cites: [] }],
    selected,
    1,
    "m1"
  );
  expect(res.ops).toHaveLength(0);
  expect(res.dropped[0].reason).toMatch(/cites/);
});

it("drops an insight with an invalid key", () => {
  const selected = [makeClaim("g1")];
  const res = admitInsights(
    [{ key: "INVALID_KEY!", value: { text: "v" }, cites: ["g1" as any] }],
    selected,
    1,
    "m1"
  );
  expect(res.ops).toHaveLength(0);
  expect(res.dropped[0].reason).toMatch(/invalid key/);
});

it("produces a derive op for a valid insight", () => {
  const selected = [makeClaim("g1")];
  const res = admitInsights(
    [{ key: "lesson.learned-x", value: { text: "v" }, cites: ["g1" as any] }],
    selected,
    1000,
    "m1"
  );
  expect(res.ops).toHaveLength(1);
  expect(res.dropped).toHaveLength(0);
  expect(res.ops[0].kind).toBe("derive");
});

it("admitted claim has correct status, source, workflow and confidence", () => {
  const selected = [makeClaim("g1")];
  const res = admitInsights(
    [{ key: "lesson.learned-x", value: { text: "v" }, cites: ["g1" as any] }],
    selected,
    1000,
    "m1"
  );
  const claim = (res.ops[0] as any).claim;
  expect(claim.status).toBe("candidate");
  expect(claim.source).toBe("llm");
  expect(claim.provenance.workflow).toBe(DREAM_WORKFLOW);
  expect(claim.confidence.distribution).toBe("beta");
  expect(claim.confidence.parameters.alpha).toBe(DREAM_PRIOR.alpha);
  expect(claim.confidence.parameters.beta).toBe(DREAM_PRIOR.beta);
  expect(claim.confidence.raw).toBe(DREAM_PRIOR.alpha / (DREAM_PRIOR.alpha + DREAM_PRIOR.beta));
});

it("admitted claim has derivedFrom with inputClaims and combinationRule", () => {
  const selected = [makeClaim("g1")];
  const nowMs = 5000;
  const modelVersion = "gpt-4o";
  const res = admitInsights(
    [{ key: "lesson.learned-x", value: { text: "v" }, cites: ["g1" as any] }],
    selected,
    nowMs,
    modelVersion
  );
  const claim = (res.ops[0] as any).claim;
  expect(claim.provenance.derivedFrom.inputClaims).toEqual(["g1"]);
  expect(claim.provenance.derivedFrom.combinationRule).toBe(`dream@${modelVersion}`);
  expect(claim.provenance.derivedFrom.corpusState).toBe(nowMs);
  expect(claim.provenance.derivedFrom.evaluationClock).toBe(nowMs);
});

it("admitted claim has evidence claim-refs matching cites", () => {
  const selected = [makeClaim("g1"), makeClaim("g2")];
  const res = admitInsights(
    [{ key: "lesson.learned-x", value: { text: "v" }, cites: ["g1" as any, "g2" as any] }],
    selected,
    1000,
    "m1"
  );
  const claim = (res.ops[0] as any).claim;
  expect(claim.evidence).toEqual([
    { kind: "claim", claimId: "g1" },
    { kind: "claim", claimId: "g2" },
  ]);
});

it("depth tag is max(cited depth) + 1 — non-dream claims have depth 0", () => {
  const selected = [makeClaim("g1"), makeClaim("g2")];
  const res = admitInsights(
    [{ key: "lesson.learned-x", value: { text: "v" }, cites: ["g1" as any, "g2" as any] }],
    selected,
    1000,
    "m1"
  );
  const claim = (res.ops[0] as any).claim;
  // Both g1 and g2 have no dream-depth tag so depth=0, result should be depth=1
  expect(claim.tags).toContain("dream-depth:1");
});

it("depth tag uses the deepest cited claim when cites have mixed depths", () => {
  const selected = [makeClaim("g1", ["dream-depth:2"]), makeClaim("g2", ["dream-depth:0"])];
  const res = admitInsights(
    [{ key: "lesson.learned-x", value: { text: "v" }, cites: ["g1" as any, "g2" as any] }],
    selected,
    1000,
    "m1"
  );
  const claim = (res.ops[0] as any).claim;
  // max(2, 0) + 1 = 3
  expect(claim.tags).toContain("dream-depth:3");
});

it("drops insight when schema rejects the scope", () => {
  const selected = [makeClaim("g1")];
  const schema: ClaimSchema = {
    version: "1.0",
    subjects: ["lesson"],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
  };
  const res = admitInsights(
    [{ key: "lesson.learned-x", value: { text: "v" }, scope: { undeclaredField: "x" }, cites: ["g1" as any] }],
    selected,
    1000,
    "m1",
    schema
  );
  expect(res.ops).toHaveLength(0);
  expect(res.dropped[0].reason).toMatch(/scope/);
});

it("skips scope validation when no schema is supplied", () => {
  const selected = [makeClaim("g1")];
  const res = admitInsights(
    [{ key: "lesson.learned-x", value: { text: "v" }, scope: { anyField: "x" }, cites: ["g1" as any] }],
    selected,
    1000,
    "m1"
    // no schema
  );
  expect(res.ops).toHaveLength(1);
});

it("admitted claim carries profile/workspace/valid/schema from the first cited claim", () => {
  const selected = [makeClaim("g1")];
  const res = admitInsights(
    [{ key: "lesson.learned-x", value: { text: "v" }, cites: ["g1" as any] }],
    selected,
    1000,
    "m1"
  );
  const claim = (res.ops[0] as any).claim;
  expect(claim.profile).toBe("p1");
  expect(claim.workspace).toBe("w1");
  expect(claim.valid).toEqual({ from: 0, to: Infinity });
  expect(claim.schema).toBe("1.0");
});

it("handles multiple insights, emitting one op per valid insight", () => {
  const selected = [makeClaim("g1"), makeClaim("g2")];
  const res = admitInsights(
    [
      { key: "lesson.a", value: { text: "va" }, cites: ["g1" as any] },
      { key: "lesson.b", value: { text: "vb" }, cites: ["missing" as any] }, // should be dropped
      { key: "lesson.c", value: { text: "vc" }, cites: ["g2" as any] },
    ],
    selected,
    1000,
    "m1"
  );
  expect(res.ops).toHaveLength(2);
  expect(res.dropped).toHaveLength(1);
});
