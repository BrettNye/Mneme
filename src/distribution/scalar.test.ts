import { scalarBinding } from "./scalar.js";

it("scalar mean is p and variance is 0", () => {
  expect(scalarBinding.mean({ p: 0.8 })).toBe(0.8);
  expect(scalarBinding.variance({ p: 0.8 })).toBe(0);
});

it("toOpinion and fromOpinion are absent on scalar binding", () => {
  expect((scalarBinding as unknown as Record<string, unknown>).toOpinion).toBeUndefined();
  expect((scalarBinding as unknown as Record<string, unknown>).fromOpinion).toBeUndefined();
});

it("supportedRules returns exactly {weighted_avg, max_mean, max_concentration}", () => {
  const rules = scalarBinding.supportedRules();
  expect(rules.size).toBe(3);
  expect(rules.has("rule_weighted_avg")).toBe(true);
  expect(rules.has("rule_max_mean")).toBe(true);
  expect(rules.has("rule_max_concentration")).toBe(true);
  expect(rules.has("rule_evidence_pooled")).toBe(false);
  expect(rules.has("rule_dempster")).toBe(false);
});

it("weighted_avg averages point values; evidence_pooled is NotSupported", () => {
  const result = scalarBinding.combine("rule_weighted_avg", { p: 0.8 }, { p: 0.4 }, { weights: [1, 1] });
  expect(result.p).toBeCloseTo(0.6, 10);
  expect(() => scalarBinding.combine("rule_evidence_pooled", { p: 0.8 }, { p: 0.4 })).toThrow(/not supported/);
});

it("weighted_avg is idempotent: combining x with x yields x", () => {
  const x = { p: 0.7 };
  expect(scalarBinding.combine("rule_weighted_avg", x, x, { weights: [1, 1] })).toEqual(x);
});

it("weighted_avg respects custom weights", () => {
  // (2*0.8 + 1*0.2) / 3 = (1.6 + 0.2) / 3 = 1.8 / 3 = 0.6
  const result = scalarBinding.combine("rule_weighted_avg", { p: 0.8 }, { p: 0.2 }, { weights: [2, 1] });
  expect(result.p).toBeCloseTo(0.6, 10);
});

it("max_mean returns the operand with higher p", () => {
  expect(scalarBinding.combine("rule_max_mean", { p: 0.8 }, { p: 0.4 })).toEqual({ p: 0.8 });
  expect(scalarBinding.combine("rule_max_mean", { p: 0.3 }, { p: 0.9 })).toEqual({ p: 0.9 });
});

it("max_mean is idempotent: combining x with x yields x", () => {
  const x = { p: 0.5 };
  expect(scalarBinding.combine("rule_max_mean", x, x)).toEqual(x);
});

it("max_concentration returns x (first arg wins on degenerate tie)", () => {
  expect(scalarBinding.combine("rule_max_concentration", { p: 0.8 }, { p: 0.4 })).toEqual({ p: 0.8 });
});

it("max_concentration is idempotent: combining x with x yields x", () => {
  const x = { p: 0.6 };
  expect(scalarBinding.combine("rule_max_concentration", x, x)).toEqual(x);
});

it("rule_dempster throws a not-supported error", () => {
  expect(() => scalarBinding.combine("rule_dempster", { p: 0.5 }, { p: 0.5 })).toThrow(/not supported/);
});

it("isIdempotent returns true for all 3 supported rules and false for unsupported", () => {
  expect(scalarBinding.isIdempotent("rule_weighted_avg")).toBe(true);
  expect(scalarBinding.isIdempotent("rule_max_mean")).toBe(true);
  expect(scalarBinding.isIdempotent("rule_max_concentration")).toBe(true);
  expect(scalarBinding.isIdempotent("rule_evidence_pooled")).toBe(false);
  expect(scalarBinding.isIdempotent("rule_dempster")).toBe(false);
});

it("serialize and deserialize roundtrip", () => {
  const d = { p: 0.42 };
  const serialized = scalarBinding.serialize(d);
  const deserialized = scalarBinding.deserialize(serialized);
  expect(deserialized).toEqual(d);
});

it("canonicalize produces expected string", () => {
  expect(scalarBinding.canonicalize({ p: 0.8 })).toBe("scalar:0.8");
});
