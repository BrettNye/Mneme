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

it("supportedRules() returns an empty set", () => {
  const rules = betaBinding.supportedRules();
  expect(rules instanceof Set).toBe(true);
  expect(rules.size).toBe(0);
});

it("combine throws with /deferred/ message", () => {
  expect(() =>
    betaBinding.combine("rule_weighted_avg", { alpha: 3, beta: 2 }, { alpha: 3, beta: 2 })
  ).toThrow(/deferred/);
});

it("isIdempotent throws (no rules in MVP)", () => {
  expect(() => betaBinding.isIdempotent("rule_weighted_avg")).toThrow();
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
