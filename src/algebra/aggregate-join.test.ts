import { wilsonLowerBound, alphaJoinAggregate, reweightWilsonFloor, reweightMultiply, reweightMultiplyMean, reweightNormalize, reweightBoost } from "./aggregate-join.js";
import type { AggregateResult } from "./aggregation.js";
import type { RankedCorpus } from "./types.js";
import type { Claim } from "../core/claim.js";

// ---------------------------------------------------------------------------
// Helpers to build minimal Claim and RankedCorpus
// ---------------------------------------------------------------------------

function makeClaim(overrides: Partial<Claim> & { scope?: Record<string, unknown> }): Claim {
  return {
    id: "c1" as any,
    profile: "p1" as any,
    workspace: "w1" as any,
    subject: { entity: "e1" } as any,
    key: { name: "action" } as any,
    scope: (overrides.scope ?? {}) as any,
    scopeHash: "sh",
    value: overrides.value ?? "default",
    valueHash: "vh",
    confidence: { distribution: "scalar", parameters: { p: 1 }, raw: 1 },
    valid: { start: 0 as any, end: null },
    recorded: 0 as any,
    recordedSeq: 0,
    status: "validated",
    source: "manual",
    provenance: { method: "manual" } as any,
    evidence: [],
    tags: [],
    schema: "v1",
    ...overrides,
  } as Claim;
}

// ---------------------------------------------------------------------------
// Wilson lower bound tests
// ---------------------------------------------------------------------------

it("Wilson lower bound penalizes the small sample (22/30 outranks 1/1)", () => {
  const wide = wilsonLowerBound({ alpha: 23, beta: 9 });   // 22 won / 8 lost
  const tiny = wilsonLowerBound({ alpha: 2, beta: 1 });    // 1 won / 0 lost
  expect(wide).toBeCloseTo(0.555, 2);
  expect(tiny).toBeCloseTo(0.207, 2);
  expect(wide).toBeGreaterThan(tiny);
});

it("Wilson lower bound returns 0 when recovered n <= 0", () => {
  // With DEFAULT_PRIOR W=2, a=0.5: alpha=1, beta=1 → r=0, s=0, n=0
  const result = wilsonLowerBound({ alpha: 1, beta: 1 });
  expect(result).toBe(0);
});

// ---------------------------------------------------------------------------
// Reweight function tests
// ---------------------------------------------------------------------------

it("reweightMultiply scales score by numeric aggregate value", () => {
  const countVal = { kind: "count" as const, n: 3 };
  const result = reweightMultiply(0.5, countVal, [countVal]);
  expect(result).toBeCloseTo(1.5);
});

it("reweightMultiplyMean scales by beta mean for rate aggregates", () => {
  // Beta(23,9): mean = 23/(23+9) = 23/32 ≈ 0.71875
  const rateVal = { kind: "rate" as const, beta: { alpha: 23, beta: 9 } };
  const result = reweightMultiplyMean(1.0, rateVal, [rateVal]);
  expect(result).toBeCloseTo(23 / 32, 5);
});

it("reweightWilsonFloor scales by Wilson lower bound for rate aggregates", () => {
  const rateVal = { kind: "rate" as const, beta: { alpha: 23, beta: 9 } };
  const result = reweightWilsonFloor(1.0, rateVal, [rateVal]);
  expect(result).toBeCloseTo(0.555, 2);
});

it("reweightNormalize divides by max aggregate value", () => {
  const low = { kind: "count" as const, n: 2 };
  const high = { kind: "count" as const, n: 10 };
  const all = [low, high];
  const result = reweightNormalize(1.0, low, all);
  expect(result).toBeCloseTo(0.2);
});

it("reweightNormalize returns original score when max is 0", () => {
  const zeroVal = { kind: "count" as const, n: 0 };
  const result = reweightNormalize(0.7, zeroVal, [zeroVal]);
  expect(result).toBeCloseTo(0.7);
});

it("reweightBoost adds value * factor to score", () => {
  const val = { kind: "count" as const, n: 5 };
  const boostFn = reweightBoost(2);
  const result = boostFn(0.3, val, [val]);
  expect(result).toBeCloseTo(0.3 + 5 * 2);
});

// ---------------------------------------------------------------------------
// alphaJoinAggregate end-to-end tests
// ---------------------------------------------------------------------------

it("alphaJoinAggregate reweights and re-sorts descending", () => {
  // Claim A: "sell" action — wide sample Beta(23,9) → Wilson ≈ 0.555
  // Claim B: "buy" action  — tiny sample Beta(2,1)  → Wilson ≈ 0.207
  // Both start with equal score 1.0
  const claimA = makeClaim({ value: "sell" });
  const claimB = makeClaim({ value: "buy" });

  const rc: RankedCorpus = {
    scored: [
      { claim: claimA, score: 1.0 },
      { claim: claimB, score: 1.0 },
    ],
  };

  const aggregate: AggregateResult = {
    groups: new Map([
      ["sell", { key: { kind: "scalar", value: "sell" }, value: { kind: "rate", beta: { alpha: 23, beta: 9 } } }],
      ["buy",  { key: { kind: "scalar", value: "buy"  }, value: { kind: "rate", beta: { alpha: 2,  beta: 1 } } }],
    ]),
  };

  const result = alphaJoinAggregate(aggregate, "value", reweightWilsonFloor)(rc);

  // "sell" (22/30) should rank above "buy" (1/1) because Wilson penalizes small samples
  expect(result.scored[0].claim.value).toBe("sell");
  expect(result.scored[1].claim.value).toBe("buy");

  // Scores should be approximately the Wilson lower bounds
  expect(result.scored[0].score).toBeCloseTo(0.555, 2);
  expect(result.scored[1].score).toBeCloseTo(0.207, 2);
});

it("alphaJoinAggregate keeps original score for unmatched claims", () => {
  const claimA = makeClaim({ value: "known" });
  const claimB = makeClaim({ value: "unknown" });

  const rc: RankedCorpus = {
    scored: [
      { claim: claimA, score: 1.0 },
      { claim: claimB, score: 0.5 },
    ],
  };

  const aggregate: AggregateResult = {
    groups: new Map([
      ["known", { key: { kind: "scalar", value: "known" }, value: { kind: "count", n: 10 } }],
    ]),
  };

  const result = alphaJoinAggregate(aggregate, "value", reweightMultiply)(rc);

  // "known" gets score 1.0 * 10 = 10
  const knownResult = result.scored.find((s) => s.claim.value === "known");
  const unknownResult = result.scored.find((s) => s.claim.value === "unknown");

  expect(knownResult?.score).toBeCloseTo(10);
  expect(unknownResult?.score).toBeCloseTo(0.5); // unchanged
});

it("alphaJoinAggregate returns sorted descending order", () => {
  const claims = ["a", "b", "c"].map((v) => makeClaim({ value: v }));
  const rc: RankedCorpus = {
    scored: [
      { claim: claims[0], score: 0.5 },
      { claim: claims[1], score: 0.5 },
      { claim: claims[2], score: 0.5 },
    ],
  };

  const aggregate: AggregateResult = {
    groups: new Map([
      ["a", { key: { kind: "scalar", value: "a" }, value: { kind: "count", n: 1 } }],
      ["b", { key: { kind: "scalar", value: "b" }, value: { kind: "count", n: 3 } }],
      ["c", { key: { kind: "scalar", value: "c" }, value: { kind: "count", n: 2 } }],
    ]),
  };

  const result = alphaJoinAggregate(aggregate, "value", reweightMultiply)(rc);

  expect(result.scored.map((s) => s.claim.value)).toEqual(["b", "c", "a"]);
  expect(result.scored.map((s) => s.score)).toEqual([1.5, 1.0, 0.5]);
});
