import { betaBinding } from "./beta.js";

it("mean of Beta(3,2) is 0.6", () => {
  expect(betaBinding.mean({ alpha: 3, beta: 2 })).toBeCloseTo(0.6);
});

it("variance of Beta(3,2) matches αβ/((α+β)²(α+β+1))", () => {
  const alpha = 3;
  const beta = 2;
  const expected = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
  expect(betaBinding.variance({ alpha, beta })).toBeCloseTo(expected);
});

it("toOpinion(Beta(1,1)) returns the vacuous opinion (uncertainty=1, using W=2 default)", () => {
  const opinion = betaBinding.toOpinion!({ alpha: 1, beta: 1 });
  // With alpha=1, beta=1, W=2, a=0.5:
  // total = 1+1=2, uncertainty = 2/2 = 1
  expect(opinion.uncertainty).toBeCloseTo(1);
  expect(opinion.belief).toBeCloseTo(0);
  expect(opinion.disbelief).toBeCloseTo(0);
  expect(opinion.baseRate).toBeCloseTo(0.5);
});

it("serialize/deserialize round-trip preserves alpha and beta", () => {
  const original = { alpha: 2.5, beta: 7.3 };
  const serialized = betaBinding.serialize(original);
  const deserialized = betaBinding.deserialize(serialized);
  expect(deserialized.alpha).toBeCloseTo(original.alpha);
  expect(deserialized.beta).toBeCloseTo(original.beta);
});

it("canonicalize is stable and order-independent", () => {
  const d = { alpha: 3, beta: 2 };
  expect(betaBinding.canonicalize(d)).toBe("beta:3:2");
  // calling again gives same result
  expect(betaBinding.canonicalize(d)).toBe("beta:3:2");
  // different values give different canonical strings
  const d2 = { alpha: 2, beta: 3 };
  expect(betaBinding.canonicalize(d2)).toBe("beta:2:3");
  expect(betaBinding.canonicalize(d)).not.toBe(betaBinding.canonicalize(d2));
});

it("fromOpinion round-trips through toOpinion for non-vacuous Beta", () => {
  const original = { alpha: 3, beta: 5 };
  const opinion = betaBinding.toOpinion!(original);
  const back = betaBinding.fromOpinion!(opinion);
  expect(back.alpha).toBeCloseTo(original.alpha);
  expect(back.beta).toBeCloseTo(original.beta);
});

// --- combine() tests (§5.6) ---

it("supportedRules() returns exactly the 5 rule ids", () => {
  const rules = betaBinding.supportedRules();
  expect(rules instanceof Set).toBe(true);
  expect(rules.size).toBe(5);
  expect(rules.has("rule_weighted_avg")).toBe(true);
  expect(rules.has("rule_evidence_pooled")).toBe(true);
  expect(rules.has("rule_max_mean")).toBe(true);
  expect(rules.has("rule_max_concentration")).toBe(true);
  expect(rules.has("rule_dempster")).toBe(true);
});

it("isIdempotent is true for weighted_avg, max_mean, max_concentration", () => {
  expect(betaBinding.isIdempotent("rule_weighted_avg")).toBe(true);
  expect(betaBinding.isIdempotent("rule_max_mean")).toBe(true);
  expect(betaBinding.isIdempotent("rule_max_concentration")).toBe(true);
});

it("isIdempotent is false for evidence_pooled and dempster", () => {
  expect(betaBinding.isIdempotent("rule_evidence_pooled")).toBe(false);
  expect(betaBinding.isIdempotent("rule_dempster")).toBe(false);
});

it("evidence_pooled of Beta(3,2) with itself is Beta(5,3) (one prior retained, §5.6)", () => {
  expect(betaBinding.combine("rule_evidence_pooled", { alpha: 3, beta: 2 }, { alpha: 3, beta: 2 }))
    .toEqual({ alpha: 5, beta: 3 });
});

it("evidence_pooled is commutative: Beta(3,2) and Beta(5,4) same in both orders", () => {
  const x = { alpha: 3, beta: 2 };
  const y = { alpha: 5, beta: 4 };
  const xy = betaBinding.combine("rule_evidence_pooled", x, y);
  const yx = betaBinding.combine("rule_evidence_pooled", y, x);
  expect(xy.alpha).toBeCloseTo(yx.alpha);
  expect(xy.beta).toBeCloseTo(yx.beta);
});

it("weighted_avg with equal weights of Beta(2,2) and Beta(6,2) is Beta(4,2)", () => {
  const result = betaBinding.combine(
    "rule_weighted_avg",
    { alpha: 2, beta: 2 },
    { alpha: 6, beta: 2 },
    { weights: [1, 1] }
  );
  expect(result.alpha).toBeCloseTo(4);
  expect(result.beta).toBeCloseTo(2);
});

it("weighted_avg with any positive weights is idempotent: combine(x,x) = x", () => {
  const x = { alpha: 3, beta: 7 };
  const result = betaBinding.combine("rule_weighted_avg", x, x, { weights: [3, 7] });
  expect(result.alpha).toBeCloseTo(x.alpha);
  expect(result.beta).toBeCloseTo(x.beta);
});

it("max_mean returns Beta(9,1) over Beta(80,20) (higher mean wins)", () => {
  // Beta(9,1): mean=0.9; Beta(80,20): mean=0.8
  const high = { alpha: 9, beta: 1 };
  const low = { alpha: 80, beta: 20 };
  expect(betaBinding.combine("rule_max_mean", high, low)).toEqual(high);
  expect(betaBinding.combine("rule_max_mean", low, high)).toEqual(high);
});

it("max_concentration returns Beta(80,20) over Beta(9,1) (higher conc wins)", () => {
  // Beta(9,1): conc=10; Beta(80,20): conc=100
  const lowConc = { alpha: 9, beta: 1 };
  const highConc = { alpha: 80, beta: 20 };
  expect(betaBinding.combine("rule_max_concentration", lowConc, highConc)).toEqual(highConc);
  expect(betaBinding.combine("rule_max_concentration", highConc, lowConc)).toEqual(highConc);
});

it("max_mean and max_concentration diverge for Beta(9,1) vs Beta(80,20)", () => {
  const x = { alpha: 9, beta: 1 };
  const y = { alpha: 80, beta: 20 };
  const byMean = betaBinding.combine("rule_max_mean", x, y);
  const byConc = betaBinding.combine("rule_max_concentration", x, y);
  expect(byMean).toEqual(x);   // mean winner
  expect(byConc).toEqual(y);   // concentration winner
  expect(byMean).not.toEqual(byConc);
});

it("dempster: combining with vacuous Beta(1,1) is identity (within float tolerance)", () => {
  const x = { alpha: 3, beta: 2 };
  const vacuous = { alpha: 1, beta: 1 };
  const result = betaBinding.combine("rule_dempster", x, vacuous);
  expect(result.alpha).toBeCloseTo(x.alpha, 5);
  expect(result.beta).toBeCloseTo(x.beta, 5);
});

it("dempster is commutative: combine(x,y) ≈ combine(y,x)", () => {
  const x = { alpha: 3, beta: 2 };
  const y = { alpha: 5, beta: 7 };
  const xy = betaBinding.combine("rule_dempster", x, y);
  const yx = betaBinding.combine("rule_dempster", y, x);
  expect(xy.alpha).toBeCloseTo(yx.alpha, 5);
  expect(xy.beta).toBeCloseTo(yx.beta, 5);
});

it("dempster throws on total conflict (maximally opposed opinions)", () => {
  // All-belief vs all-disbelief → high conflict, but can't easily get K=1 exactly with Beta
  // A near-dogmatic belief opinion vs near-dogmatic disbelief
  // belief≈1, disbelief≈0 vs belief≈0, disbelief≈1 → K ≈ 1
  // Use very large alpha for first, very large beta for second
  expect(() =>
    betaBinding.combine("rule_dempster", { alpha: 1000000, beta: 1 }, { alpha: 1, beta: 1000000 })
  ).toThrow(/conflict/i);
});

it("combine throws for unknown rule id", () => {
  expect(() =>
    betaBinding.combine("rule_unknown", { alpha: 3, beta: 2 }, { alpha: 3, beta: 2 })
  ).toThrow(/not supported/i);
});
