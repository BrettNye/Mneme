import { scalarBinding } from "./scalar.js";

it("scalar mean is p and variance is 0", () => {
  expect(scalarBinding.mean({ p: 0.8 })).toBe(0.8);
  expect(scalarBinding.variance({ p: 0.8 })).toBe(0);
});

it("toOpinion and fromOpinion are absent on scalar binding", () => {
  expect((scalarBinding as unknown as Record<string, unknown>).toOpinion).toBeUndefined();
  expect((scalarBinding as unknown as Record<string, unknown>).fromOpinion).toBeUndefined();
});

it("supportedRules returns empty set", () => {
  const rules = scalarBinding.supportedRules();
  expect(rules.size).toBe(0);
});

it("combine throws indicating combination rules are deferred", () => {
  expect(() => scalarBinding.combine("any-rule", { p: 0.5 }, { p: 0.7 })).toThrow();
});

it("isIdempotent throws indicating no rules in MVP", () => {
  expect(() => scalarBinding.isIdempotent("any-rule")).toThrow();
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
