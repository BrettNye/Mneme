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

import { cardinalityOf } from "./schema.js";

it("undeclared key defaults to single (no map)", () => {
  expect(cardinalityOf("hobby")).toBe("single");
});

it("undeclared key defaults to single (empty map)", () => {
  expect(cardinalityOf("hobby", {})).toBe("single");
});

it("declared multi key returns multi", () => {
  expect(cardinalityOf("tags", { tags: "multi" })).toBe("multi");
});

it("declared single key returns single", () => {
  expect(cardinalityOf("name", { name: "single" })).toBe("single");
});

it("invalid cardinality value throws with matching message", () => {
  expect(() => cardinalityOf("k", { k: "many" as any })).toThrow(/invalid keyCardinality/);
});

it("ClaimSchema literal with keyCardinality type-checks at runtime", () => {
  const schemaWithCardinality: ClaimSchema = {
    ...schema,
    keyCardinality: { hobby: "multi" },
  };
  expect(schemaWithCardinality.keyCardinality).toEqual({ hobby: "multi" });
});

it("ClaimSchema without keyCardinality field type-checks (optional)", () => {
  const schemaWithout: ClaimSchema = { ...schema };
  expect(schemaWithout.keyCardinality).toBeUndefined();
});
