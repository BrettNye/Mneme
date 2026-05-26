import { simJaccard, simExact, similarityFn, rho } from "./similarity.js";
import { corpusOf } from "./types.js";

// sim_jaccard basic properties
it("jaccard returns 1 for identical token sets", () => {
  expect(simJaccard.scoreOne("hello world", "hello world")).toBe(1);
});

it("jaccard is symmetric", () => {
  const a = simJaccard.scoreOne("lineage block schema", "lineage block");
  const b = simJaccard.scoreOne("lineage block", "lineage block schema");
  expect(a).toBeCloseTo(b);
});

it("jaccard returns value in [0,1]", () => {
  const score = simJaccard.scoreOne("foo bar", "baz qux");
  expect(score).toBeGreaterThanOrEqual(0);
  expect(score).toBeLessThanOrEqual(1);
});

it("jaccard returns 1 when both inputs have no tokens", () => {
  expect(simJaccard.scoreOne("", "")).toBe(1);
});

it("jaccard ranks the more token-overlapping claim higher", () => {
  expect(simJaccard.scoreOne("lineage block schema", "lineage block")).toBeGreaterThan(
    simJaccard.scoreOne("unrelated text", "lineage block")
  );
  const ranked = rho("jaccard", "lineage block schema")(
    corpusOf([
      { value: "unrelated" } as any,
      { value: "lineage block schema design" } as any,
    ])
  );
  expect(ranked.scored[0].claim.value).toBe("lineage block schema design");
});

// sim_exact
it("simExact returns 1 for identical values", () => {
  expect(simExact.scoreOne("hello", "hello")).toBe(1);
  expect(simExact.scoreOne(42, 42)).toBe(1);
  expect(simExact.scoreOne(null, null)).toBe(1);
});

it("simExact returns 0 for different values", () => {
  expect(simExact.scoreOne("hello", "world")).toBe(0);
  expect(simExact.scoreOne(1, 2)).toBe(0);
});

// object Value tokenization (regression: no "[object Object]" collapse)
it("jaccard scores objects with different content less than 1", () => {
  expect(simJaccard.scoreOne({ a: 1 }, { b: 2 })).toBeLessThan(1);
});

it("jaccard returns 1 for identical objects", () => {
  expect(simJaccard.scoreOne({ a: 1 }, { a: 1 })).toBe(1);
});

// simExact key-order insensitivity
it("simExact returns 1 for objects differing only in key order", () => {
  expect(simExact.scoreOne({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(1);
});

it("simExact returns 0 for genuinely different objects", () => {
  expect(simExact.scoreOne({ a: 1 }, { a: 2 })).toBe(0);
});

// isPure
it("both similarity fns declare isPure: true", () => {
  expect(simJaccard.isPure).toBe(true);
  expect(simExact.isPure).toBe(true);
});

// registry
it("similarityFn resolves jaccard by name", () => {
  expect(similarityFn("jaccard")).toBe(simJaccard);
});

it("similarityFn resolves exact by name", () => {
  expect(similarityFn("exact")).toBe(simExact);
});

it("similarityFn throws for unknown name", () => {
  expect(() => similarityFn("nonexistent")).toThrow(/no similarity fn "nonexistent"/);
});

it("similarity fns expose a stable version identifier", () => {
  expect(simJaccard.version).toBe("jaccard@1");
  expect(simExact.version).toBe("exact@1");
  expect(similarityFn("jaccard").version).toBe("jaccard@1");
});

// rho operator
it("rho returns a RankedCorpus sorted by descending score", () => {
  const corpus = corpusOf([
    { value: "cat" } as any,
    { value: "dog cat" } as any,
    { value: "completely different" } as any,
  ]);
  const ranked = rho("jaccard", "cat")(corpus);
  for (let i = 0; i < ranked.scored.length - 1; i++) {
    expect(ranked.scored[i].score).toBeGreaterThanOrEqual(ranked.scored[i + 1].score);
  }
});
