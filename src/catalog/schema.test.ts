import { validateScope, pseudocountFor, getValueSchema, type ClaimSchema } from "./schema.js";
import { z } from "zod";

const schema: ClaimSchema = {
  version: "1.0.0",
  subjects: ["repo"],
  scopeFields: { runId: "string" },
  required: [],
  scalarPseudocount: { llm: 2 },
};

it("rejects undeclared scope fields (strict scope)", () => {
  expect(() => validateScope({ entityId: "x" }, schema)).toThrow(/strict scope/);
});

it("allows declared scope fields", () => {
  expect(() => validateScope({ runId: "abc" }, schema)).not.toThrow();
});

it("allows empty scope", () => {
  expect(() => validateScope({}, schema)).not.toThrow();
});

it("pseudocountFor returns declared value", () => {
  expect(pseudocountFor("llm", schema)).toBe(2);
});

it("pseudocountFor throws for undeclared source (no silent default)", () => {
  expect(() => pseudocountFor("manual", schema)).toThrow(/no scalarPseudocount/);
});

it("exposes per-key value schema for type-checking", () => {
  const schemaWithValues: ClaimSchema = {
    ...schema,
    valueSchemas: { score: z.number().min(0).max(1) },
  };
  const valueSchema = getValueSchema("score", schemaWithValues);
  expect(valueSchema).toBeDefined();
  // valid value passes
  expect(() => valueSchema!.parse(0.5)).not.toThrow();
  // invalid value throws
  expect(() => valueSchema!.parse("not-a-number")).toThrow();
});

it("getValueSchema returns undefined for undeclared key", () => {
  expect(getValueSchema("undeclared", schema)).toBeUndefined();
});
