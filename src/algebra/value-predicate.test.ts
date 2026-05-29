import { z } from "zod";
import {
  typecheckValuePredicate,
  getPath,
  matchesValue,
} from "./value-predicate.js";
import type { ClaimSchema } from "../catalog/schema.js";

// ---------------------------------------------------------------------------
// typecheckValuePredicate — parse-time type-checking
// ---------------------------------------------------------------------------

it("rejects a predicate on a field absent from the declared value schema", () => {
  const schema = {
    valueSchemas: { "action.outcome": { won: "boolean" } },
  } as unknown as ClaimSchema;
  expect(() =>
    typecheckValuePredicate(
      { op: "valueEq", path: "lost", value: true },
      "action.outcome",
      schema
    )
  ).toThrow();
});

it("allows a predicate when no valueSchema is declared for the key (dynamically typed)", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    // no valueSchemas
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueEq", path: "anything", value: 42 },
      "some.key",
      schema
    )
  ).not.toThrow();
});

it("allows a predicate when valueSchemas exists but has no entry for the key", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {},
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueEq", path: "anything", value: 42 },
      "some.key",
      schema
    )
  ).not.toThrow();
});

it("accepts a valid valueEq predicate on a declared field", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "action.outcome": z.object({ won: z.boolean() }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueEq", path: "won", value: true },
      "action.outcome",
      schema
    )
  ).not.toThrow();
});

it("rejects a type-incompatible valueEq comparison (string value on boolean field)", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "action.outcome": z.object({ won: z.boolean() }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueEq", path: "won", value: "yes" },
      "action.outcome",
      schema
    )
  ).toThrow();
});

it("rejects a valueGt predicate on a non-number field", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "action.outcome": z.object({ label: z.string() }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueGt", path: "label", value: 5 },
      "action.outcome",
      schema
    )
  ).toThrow();
});

it("accepts a valueGt predicate on a number field", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "action.outcome": z.object({ score: z.number() }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueGt", path: "score", value: 10 },
      "action.outcome",
      schema
    )
  ).not.toThrow();
});

it("rejects an out-of-enum value in valueEq predicate", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "action.result": z.object({ status: z.enum(["win", "lose", "draw"]) }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueEq", path: "status", value: "unknown" },
      "action.result",
      schema
    )
  ).toThrow();
});

it("accepts a valid enum value in valueEq predicate", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "action.result": z.object({ status: z.enum(["win", "lose", "draw"]) }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueEq", path: "status", value: "win" },
      "action.result",
      schema
    )
  ).not.toThrow();
});

it("rejects an out-of-enum value in valueIn predicate", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "action.result": z.object({ status: z.enum(["win", "lose", "draw"]) }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueIn", path: "status", values: ["win", "invalid"] },
      "action.result",
      schema
    )
  ).toThrow();
});

it("accepts valid valueExists predicate on a declared field", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "action.outcome": z.object({ won: z.boolean() }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueExists", path: "won" },
      "action.outcome",
      schema
    )
  ).not.toThrow();
});

it("rejects valueExists on absent field in declared schema", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "action.outcome": z.object({ won: z.boolean() }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueExists", path: "missing" },
      "action.outcome",
      schema
    )
  ).toThrow();
});

// ---------------------------------------------------------------------------
// getPath — dotted access and array indexing
// ---------------------------------------------------------------------------

it("getPath returns the value for a simple key", () => {
  expect(getPath({ score: 42 }, "score")).toBe(42);
});

it("getPath returns undefined for a missing key", () => {
  expect(getPath({ score: 42 }, "missing")).toBeUndefined();
});

it("getPath supports dotted path access", () => {
  expect(getPath({ a: { b: { c: 99 } } }, "a.b.c")).toBe(99);
});

it("getPath returns undefined for a missing nested key", () => {
  expect(getPath({ a: { b: 1 } }, "a.x.c")).toBeUndefined();
});

it("getPath supports array index access with bracket notation", () => {
  expect(getPath({ items: ["x", "y", "z"] }, "items[1]")).toBe("y");
});

it("getPath supports array index access with dot notation", () => {
  expect(getPath({ items: ["x", "y", "z"] }, "items.0")).toBe("x");
});

it("getPath supports mixed dotted and bracket notation", () => {
  expect(getPath({ a: [{ b: 7 }, { b: 8 }] }, "a[1].b")).toBe(8);
});

it("getPath returns undefined when indexing into non-array", () => {
  expect(getPath({ a: "not-an-array" }, "a[0]")).toBeUndefined();
});

it("getPath returns undefined when value is null at intermediate path", () => {
  expect(getPath({ a: null }, "a.b")).toBeUndefined();
});

// ---------------------------------------------------------------------------
// matchesValue — runtime evaluation
// ---------------------------------------------------------------------------

it("matchesValue valueEq returns true for deep-equal values", () => {
  expect(matchesValue({ score: 10 }, { op: "valueEq", path: "score", value: 10 })).toBe(true);
});

it("matchesValue valueEq returns false for non-equal values", () => {
  expect(matchesValue({ score: 10 }, { op: "valueEq", path: "score", value: 99 })).toBe(false);
});

it("matchesValue valueEq returns false when path is absent", () => {
  expect(matchesValue({ score: 10 }, { op: "valueEq", path: "other", value: 10 })).toBe(false);
});

it("matchesValue valueEq deep-equals complex objects", () => {
  expect(
    matchesValue(
      { meta: { tags: [1, 2, 3] } },
      { op: "valueEq", path: "meta", value: { tags: [1, 2, 3] } }
    )
  ).toBe(true);
});

it("matchesValue valueGt returns true when resolved value > predicate value", () => {
  expect(matchesValue({ score: 15 }, { op: "valueGt", path: "score", value: 10 })).toBe(true);
});

it("matchesValue valueGt returns false when resolved value <= predicate value", () => {
  expect(matchesValue({ score: 5 }, { op: "valueGt", path: "score", value: 10 })).toBe(false);
});

it("matchesValue valueGt throws a typed error on non-number value (never silent false)", () => {
  expect(() =>
    matchesValue({ score: "fifteen" }, { op: "valueGt", path: "score", value: 10 })
  ).toThrow();
});

it("matchesValue valueGt throws when path resolves to null", () => {
  expect(() =>
    matchesValue({ score: null }, { op: "valueGt", path: "score", value: 10 })
  ).toThrow();
});

it("matchesValue valueIn returns true when value is in the list", () => {
  expect(
    matchesValue({ status: "win" }, { op: "valueIn", path: "status", values: ["win", "lose"] })
  ).toBe(true);
});

it("matchesValue valueIn returns false when value is not in the list", () => {
  expect(
    matchesValue({ status: "draw" }, { op: "valueIn", path: "status", values: ["win", "lose"] })
  ).toBe(false);
});

it("matchesValue valueIn returns false when path is absent", () => {
  expect(
    matchesValue({}, { op: "valueIn", path: "status", values: ["win"] })
  ).toBe(false);
});

it("matchesValue valueExists returns true when path is present", () => {
  expect(matchesValue({ a: null }, { op: "valueExists", path: "a" })).toBe(true);
});

it("matchesValue valueExists returns false when path is absent", () => {
  expect(matchesValue({}, { op: "valueExists", path: "a" })).toBe(false);
});

it("matchesValue valueGt throws when path is absent", () => {
  expect(() =>
    matchesValue({}, { op: "valueGt", path: "score", value: 10 })
  ).toThrow();
});

// ---------------------------------------------------------------------------
// ZodDefault / ZodBranded unwrapping in typecheckValuePredicate
// ---------------------------------------------------------------------------

it("accepts a valueGt predicate on a defaulted numeric field (ZodDefault unwrapping)", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "game.score": z.object({ score: z.number().default(0) }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueGt", path: "score", value: 5 },
      "game.score",
      schema
    )
  ).not.toThrow();
});

// ---------------------------------------------------------------------------
// valueRegex — typecheck (parse-time)
// ---------------------------------------------------------------------------

it("rejects a valueRegex predicate on a non-string field", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "action.outcome": z.object({ score: z.number() }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueRegex", path: "score", pattern: "^\\d+$" },
      "action.outcome",
      schema
    )
  ).toThrow();
});

it("accepts a valueRegex predicate on a string field", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "action.outcome": z.object({ label: z.string() }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueRegex", path: "label", pattern: "^foo" },
      "action.outcome",
      schema
    )
  ).not.toThrow();
});

it("rejects a valueRegex predicate on a field absent from the declared schema", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "action.outcome": z.object({ label: z.string() }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueRegex", path: "missing", pattern: "^foo" },
      "action.outcome",
      schema
    )
  ).toThrow();
});

// ---------------------------------------------------------------------------
// valueNull — typecheck (parse-time)
// ---------------------------------------------------------------------------

it("accepts a valueNull predicate on a declared field", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "action.outcome": z.object({ note: z.string().nullable() }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueNull", path: "note" },
      "action.outcome",
      schema
    )
  ).not.toThrow();
});

it("rejects a valueNull predicate on a field absent from the declared schema", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "action.outcome": z.object({ note: z.string().nullable() }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueNull", path: "missing" },
      "action.outcome",
      schema
    )
  ).toThrow();
});

// ---------------------------------------------------------------------------
// valueMatches — typecheck (parse-time, dynamically typed no-op)
// ---------------------------------------------------------------------------

it("accepts a valueMatches predicate without checking against the declared schema (dynamically typed)", () => {
  const schema: ClaimSchema = {
    version: "1",
    subjects: [],
    scopeFields: {},
    required: [],
    scalarPseudocount: {},
    valueSchemas: {
      "action.outcome": z.object({ won: z.boolean() }),
    },
  };
  expect(() =>
    typecheckValuePredicate(
      { op: "valueMatches", pattern: { anything: 123 } },
      "action.outcome",
      schema
    )
  ).not.toThrow();
});

// ---------------------------------------------------------------------------
// getPath — null vs undefined distinction
// ---------------------------------------------------------------------------

it("getPath returns null (not undefined) when the stored value is literally null", () => {
  expect(getPath({ a: null }, "a")).toBeNull();
});

// ---------------------------------------------------------------------------
// matchesValue — valueRegex (runtime)
// ---------------------------------------------------------------------------

it("matchesValue valueRegex returns true when the string matches the pattern", () => {
  expect(
    matchesValue({ label: "foobar" }, { op: "valueRegex", path: "label", pattern: "^foo" })
  ).toBe(true);
});

it("matchesValue valueRegex returns false when the string does not match the pattern", () => {
  expect(
    matchesValue({ label: "barbaz" }, { op: "valueRegex", path: "label", pattern: "^foo" })
  ).toBe(false);
});

it("matchesValue valueRegex throws a typed error on a non-string value (never silent false)", () => {
  expect(() =>
    matchesValue({ label: 42 }, { op: "valueRegex", path: "label", pattern: "^foo" })
  ).toThrow();
});

it("matchesValue valueRegex returns false when the path is absent", () => {
  expect(
    matchesValue({}, { op: "valueRegex", path: "label", pattern: "^foo" })
  ).toBe(false);
});

// ---------------------------------------------------------------------------
// matchesValue — valueNull (runtime)
// ---------------------------------------------------------------------------

it("matchesValue valueNull returns true when the path resolves to JSON null", () => {
  expect(matchesValue({ note: null }, { op: "valueNull", path: "note" })).toBe(true);
});

it("matchesValue valueNull returns false when the path is absent", () => {
  expect(matchesValue({}, { op: "valueNull", path: "note" })).toBe(false);
});

it("matchesValue valueNull returns false when the path resolves to a non-null value", () => {
  expect(matchesValue({ note: "hi" }, { op: "valueNull", path: "note" })).toBe(false);
});

// ---------------------------------------------------------------------------
// matchesValue — valueMatches (whole-value structural match)
// ---------------------------------------------------------------------------

it("matchesValue valueMatches returns true on a subset object match (extra keys allowed)", () => {
  expect(
    matchesValue(
      { a: 1, b: 2, c: 3 },
      { op: "valueMatches", pattern: { a: 1, b: 2 } }
    )
  ).toBe(true);
});

it("matchesValue valueMatches returns true on a nested structural match", () => {
  expect(
    matchesValue(
      { meta: { tags: ["x"], count: 5 }, extra: true },
      { op: "valueMatches", pattern: { meta: { count: 5 } } }
    )
  ).toBe(true);
});

it("matchesValue valueMatches matches arrays element-wise", () => {
  expect(
    matchesValue(
      { items: [{ id: 1, name: "a" }, { id: 2, name: "b" }] },
      { op: "valueMatches", pattern: { items: [{ id: 1 }, { id: 2 }] } }
    )
  ).toBe(true);
});

it("matchesValue valueMatches returns false on a value mismatch", () => {
  expect(
    matchesValue(
      { a: 1, b: 2 },
      { op: "valueMatches", pattern: { a: 1, b: 99 } }
    )
  ).toBe(false);
});

it("matchesValue valueMatches returns false when a pattern key is absent in the value", () => {
  expect(
    matchesValue(
      { a: 1 },
      { op: "valueMatches", pattern: { a: 1, b: 2 } }
    )
  ).toBe(false);
});

it("matchesValue valueMatches returns false when array lengths differ", () => {
  expect(
    matchesValue(
      { items: [1, 2] },
      { op: "valueMatches", pattern: { items: [1, 2, 3] } }
    )
  ).toBe(false);
});
