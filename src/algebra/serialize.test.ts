import { serializeExpr, parseExpr } from "./serialize.js";
import {
  leaf,
  sigma,
  tau,
  delta,
  pi,
  rho,
  gamma,
  kappa,
  combine,
  synthesize,
  resolve,
  aggregate,
} from "./ast.js";
import type { ExprNode } from "./ast.js";

// -- Basic round-trip from the task spec --

it("round-trips sigma+leaf node and is key-order stable", () => {
  const n = sigma({ op: "keyEq", value: "k" }, leaf("c"));
  expect(parseExpr(serializeExpr(n))).toEqual(n);
  // Two structurally equal nodes with different key insertion order must serialize identically.
  // JSON.parse gives an object whose key order matches the JSON string, so this exercises canonicalize.
  expect(serializeExpr(n)).toBe(serializeExpr(JSON.parse(JSON.stringify(n)) as ExprNode));
});

// -- Round-trip for all 12 variants --

const allVariants: Array<[string, ExprNode]> = [
  ["leaf", leaf("corpus-1")],
  ["sigma", sigma({ op: "subjectEq", value: "alice" }, leaf("c"))],
  ["tau (no t)", tau("valid", leaf("c"))],
  ["tau (with t)", tau("recorded", leaf("c"), 1_700_000_000)],
  ["delta", delta({ kind: "exponential", halfLifeDays: 30 }, leaf("c"))],
  ["pi", pi(["subject", "key"], leaf("c"))],
  ["rho", rho("cosine", "query text", leaf("c"))],
  ["gamma", gamma(3, leaf("c"))],
  ["kappa (no dedup)", kappa("markdown", 512, leaf("c"))],
  ["kappa (with dedup)", kappa("xml", 1024, leaf("c"), 0.8)],
  ["combine (no params)", combine("weightedAvg", leaf("c"))],
  ["combine (with params)", combine("weightedAvg", leaf("c"), { weights: [0.5, 0.5] })],
  ["synthesize (no params)", synthesize("subj", "bio", "llmSynth", leaf("c"))],
  ["synthesize (with params)", synthesize("subj", "bio", "llmSynth", leaf("c"), { temperature: 0.7 })],
  ["resolve (no rule)", resolve("latestWins", leaf("c"), undefined, 0.5)],
  ["resolve (with rule)", resolve("latestWins", leaf("c"), "deprecate_lower", 0.5)],
  ["aggregate (minimal)", aggregate("count", leaf("c"))],
  [
    "aggregate (full)",
    aggregate("mean", leaf("c"), {
      reweight: "byRecency",
      where: { op: "confidenceGt", value: 0.5 },
      groupBy: "key",
    }),
  ],
];

for (const [name, node] of allVariants) {
  it(`round-trips ${name}`, () => {
    expect(parseExpr(serializeExpr(node))).toEqual(node);
  });
}

// -- Canonical key ordering --

it("key order is stable regardless of insertion order", () => {
  // Build a sigma node two ways with different property insertion orders
  const a = sigma({ op: "keyEq", value: "x" }, leaf("c"));
  // Manually create same structure with shuffled key order
  const b = { src: { corpusId: "c", op: "leaf" }, pred: { value: "x", op: "keyEq" }, op: "sigma" } as ExprNode;
  expect(serializeExpr(a)).toBe(serializeExpr(b));
});

it("nested predicate key order is stable", () => {
  const n = sigma(
    { op: "and", preds: [{ op: "keyEq", value: "k" }, { op: "subjectEq", value: "s" }] },
    leaf("c"),
  );
  // Construct manually with reversed key order in predicate
  const n2 = {
    op: "sigma",
    src: { op: "leaf", corpusId: "c" },
    pred: { preds: [{ value: "k", op: "keyEq" }, { value: "s", op: "subjectEq" }], op: "and" },
  } as ExprNode;
  expect(serializeExpr(n)).toBe(serializeExpr(n2));
});

// -- Validation errors --

it("parseExpr throws on unknown op", () => {
  const bad = JSON.stringify({ op: "unknown_op", src: { op: "leaf", corpusId: "c" } });
  expect(() => parseExpr(bad)).toThrow();
});

it("parseExpr throws on missing required field (leaf missing corpusId)", () => {
  const bad = JSON.stringify({ op: "leaf" });
  expect(() => parseExpr(bad)).toThrow();
});

it("parseExpr throws on missing required field (sigma missing pred)", () => {
  const bad = JSON.stringify({ op: "sigma", src: { op: "leaf", corpusId: "c" } });
  expect(() => parseExpr(bad)).toThrow();
});

it("parseExpr throws on missing required field (sigma missing src)", () => {
  const bad = JSON.stringify({ op: "sigma", pred: { op: "keyEq", value: "k" } });
  expect(() => parseExpr(bad)).toThrow();
});

it("parseExpr throws when nested src has unknown op", () => {
  const bad = JSON.stringify({
    op: "sigma",
    pred: { op: "keyEq", value: "k" },
    src: { op: "NOT_REAL", corpusId: "c" },
  });
  expect(() => parseExpr(bad)).toThrow();
});

it("parseExpr throws on malformed JSON", () => {
  expect(() => parseExpr("{not valid json")).toThrow();
});

it("parseExpr throws when op is absent entirely", () => {
  expect(() => parseExpr(JSON.stringify({ corpusId: "c" }))).toThrow();
});

// -- Nested src chain validation --

it("validates deeply nested src chains recursively", () => {
  // valid 3-deep chain
  const n = sigma({ op: "keyEq", value: "k" }, tau("valid", leaf("c")));
  expect(parseExpr(serializeExpr(n))).toEqual(n);

  // invalid leaf at the bottom of the chain
  const bad = JSON.stringify({
    op: "sigma",
    pred: { op: "keyEq", value: "k" },
    src: { op: "tau", mode: "valid", src: { op: "BAD", corpusId: "c" } },
  });
  expect(() => parseExpr(bad)).toThrow();
});

// -- Value/params round-trip (arbitrary nested JSON) --

it("round-trips rho with complex nested query value", () => {
  const n = rho("semanticSearch", { terms: ["a", "b"], boost: { title: 2 } }, leaf("c"));
  expect(parseExpr(serializeExpr(n))).toEqual(n);
});

it("round-trips combine with null params value", () => {
  const n = combine("rule", leaf("c"), null);
  expect(parseExpr(serializeExpr(n))).toEqual(n);
});

// -- resolve threshold --

it("round-trips a resolve node with threshold", () => {
  const n = resolve("resolveKeepBoth", leaf("c"), undefined, 0.3);
  expect(serializeExpr(parseExpr(serializeExpr(n)))).toBe(serializeExpr(n));
});

it("rejects a resolve node missing threshold", () => {
  expect(() => parseExpr('{"op":"resolve","policy":"resolveKeepBoth","src":{"op":"leaf","corpusId":"c"}}')).toThrow();
});

// -- new optional fields: keyCardinality + combine.similarity --

it("round-trips resolve.keyCardinality and combine.similarity", () => {
  const expr = resolve(
    "resolveDeprecateOlder",
    combine("rule_weighted_avg", leaf("c"), undefined, { fn: "jaccard", cutoff: 0.5 }),
    undefined,
    0,
    { hobby: "multi" },
  );
  const parsed = parseExpr(serializeExpr(expr));
  expect(serializeExpr(parsed)).toBe(serializeExpr(expr));
});
