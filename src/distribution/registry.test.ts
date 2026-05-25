import { bindingFor, serializeParams, deserializeParams } from "./registry.js";

it("resolves beta and round-trips params; rejects unknown", () => {
  expect(bindingFor("beta").mean({ alpha: 3, beta: 2 })).toBeCloseTo(0.6);
  expect(deserializeParams("beta", serializeParams("beta", { alpha: 3, beta: 2 }))).toEqual({ alpha: 3, beta: 2 });
  expect(() => bindingFor("dirichlet")).toThrow(/no distribution binding/);
});

it("resolves scalar and round-trips params", () => {
  expect(bindingFor("scalar").mean({ p: 0.75 })).toBeCloseTo(0.75);
  expect(deserializeParams("scalar", serializeParams("scalar", { p: 0.75 }))).toEqual({ p: 0.75 });
});

it("serializeParams and deserializeParams round-trip beta params", () => {
  const params = { alpha: 5, beta: 10 };
  const blob = serializeParams("beta", params);
  expect(typeof blob).toBe("string");
  expect(deserializeParams("beta", blob)).toEqual(params);
});

it("serializeParams and deserializeParams round-trip scalar params", () => {
  const params = { p: 0.3 };
  const blob = serializeParams("scalar", params);
  expect(typeof blob).toBe("string");
  expect(deserializeParams("scalar", blob)).toEqual(params);
});

it("bindingFor unknown distribution throws with descriptive message", () => {
  expect(() => bindingFor("gaussian")).toThrow(/no distribution binding registered for "gaussian"/);
});
