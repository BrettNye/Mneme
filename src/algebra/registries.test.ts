import { resolutionRegistry, reweightRegistry, MissingRule } from "./registries.js";

it("resolutionRegistry resolves all six shipped resolution policies as functions", () => {
  const names = [
    "resolveDeprecateLower",
    "resolveKeepBoth",
    "resolveFlagForReview",
    "resolveDeprecateMinority",
    "resolvePromoteConsensus",
    "resolveSynthesizeBelief",
  ];
  for (const name of names) {
    expect(resolutionRegistry(name), `expected ${name} to be a function`).toBeTypeOf("function");
  }
});

it("resolutionRegistry throws MissingRule on unknown name", () => {
  expect(() => resolutionRegistry("nope")).toThrow(MissingRule);
});

it("MissingRule carries family and name on resolution miss", () => {
  let caught: unknown;
  try {
    resolutionRegistry("unknown-policy");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(MissingRule);
  const err = caught as MissingRule;
  expect(err.family).toBe("resolution");
  expect(err.name).toBe("unknown-policy");
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

it("MissingRule carries family and name on reweight miss", () => {
  let caught: unknown;
  try {
    reweightRegistry("unknown-reweight");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(MissingRule);
  const err = caught as MissingRule;
  expect(err.family).toBe("reweight");
  expect(err.name).toBe("unknown-reweight");
});
