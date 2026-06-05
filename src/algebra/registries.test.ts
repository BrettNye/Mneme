import { resolutionRegistry, reweightRegistry, MissingRule } from "./registries.js";

it("resolutionRegistry resolves all seven shipped resolution policies as functions", () => {
  const names = [
    "resolveDeprecateLower",
    "resolveDeprecateOlder",
    "resolveKeepBoth",
    "resolveFlagForReview",
    "resolveDeprecateMinority",
    "resolvePromoteConsensus",
    "resolveSynthesizeBelief",
  ];
  for (const name of names) {
    expect(typeof resolutionRegistry(name).fn, `expected ${name}.fn to be a function`).toBe("function");
  }
});

it("resolutionRegistry returns fn + input-kind per policy", () => {
  expect(resolutionRegistry("resolveKeepBoth").input).toBe("pairs");
  expect(resolutionRegistry("resolveDeprecateLower").input).toBe("pairs");
  expect(resolutionRegistry("resolveDeprecateOlder").input).toBe("pairs");
  expect(resolutionRegistry("resolveFlagForReview").input).toBe("pairs");
  expect(resolutionRegistry("resolveDeprecateMinority").input).toBe("clusters");
  expect(resolutionRegistry("resolvePromoteConsensus").input).toBe("clusters");
  expect(resolutionRegistry("resolveSynthesizeBelief").input).toBe("clusters");
  expect(typeof resolutionRegistry("resolveSynthesizeBelief").fn).toBe("function");
});

it("resolutionRegistry resolves resolveDeprecateOlder as a pairs resolver", () => {
  expect(resolutionRegistry("resolveDeprecateOlder").input).toBe("pairs");
});

it("resolutionRegistry throws MissingRule on unknown name", () => {
  expect(() => resolutionRegistry("nope")).toThrow(MissingRule);
});

it("MissingRule carries family and ruleName on resolution miss", () => {
  let caught: unknown;
  try {
    resolutionRegistry("unknown-policy");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(MissingRule);
  const err = caught as MissingRule;
  expect(err.family).toBe("resolution");
  expect(err.ruleName).toBe("unknown-policy");
});

it("reweightRegistry resolves all five shipped reweight functions", () => {
  const names = [
    "reweightMultiply",
    "reweightMultiplyMean",
    "reweightWilsonFloor",
    "reweightNormalize",
    "reweightBoost",
  ];
  for (const name of names) {
    expect(reweightRegistry(name), `expected ${name} to be a function`).toBeTypeOf("function");
  }
});

it("reweightRegistry throws MissingRule on unknown name", () => {
  expect(() => reweightRegistry("nope")).toThrow(MissingRule);
});

it("MissingRule carries family and ruleName on reweight miss", () => {
  let caught: unknown;
  try {
    reweightRegistry("unknown-reweight");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(MissingRule);
  const err = caught as MissingRule;
  expect(err.family).toBe("reweight");
  expect(err.ruleName).toBe("unknown-reweight");
});

it("resolutionRegistry throws MissingRule for inherited Object.prototype keys", () => {
  expect(() => resolutionRegistry("constructor")).toThrow(MissingRule);
  expect(() => resolutionRegistry("toString")).toThrow(MissingRule);
  expect(() => resolutionRegistry("hasOwnProperty")).toThrow(MissingRule);
});

it("reweightRegistry throws MissingRule for inherited Object.prototype keys", () => {
  expect(() => reweightRegistry("constructor")).toThrow(MissingRule);
  expect(() => reweightRegistry("__proto__")).toThrow(MissingRule);
  expect(() => reweightRegistry("toString")).toThrow(MissingRule);
});
