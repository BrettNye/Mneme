import { simJaccard, simExact, similarityFn, rho, registerSimilarity, hybridMax, relevanceFloor } from "./similarity.js";
import type { SimilarityFn } from "./similarity.js";
import type { Stage, EvalContext } from "./expression.js";
import type { RankedCorpus } from "./types.js";
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

// ── registerSimilarity ────────────────────────────────────────────────────────

it("registerSimilarity: registered fn is retrievable by name", () => {
  const fn: SimilarityFn = { isPure: true, version: "custom@1", scoreOne: () => 0.5 };
  registerSimilarity("custom-reg-test", fn);
  expect(similarityFn("custom-reg-test")).toBe(fn);
});

it("registerSimilarity: re-registering the same object is a no-op", () => {
  const fn: SimilarityFn = { isPure: true, version: "noop@1", scoreOne: () => 0 };
  registerSimilarity("noop-reg-test", fn);
  // same object again — should not throw
  expect(() => registerSimilarity("noop-reg-test", fn)).not.toThrow();
  expect(similarityFn("noop-reg-test")).toBe(fn);
});

it("registerSimilarity: registering a different object throws /already registered/", () => {
  const fn1: SimilarityFn = { isPure: true, version: "a@1", scoreOne: () => 0 };
  const fn2: SimilarityFn = { isPure: true, version: "b@1", scoreOne: () => 1 };
  registerSimilarity("collision-reg-test", fn1);
  expect(() => registerSimilarity("collision-reg-test", fn2)).toThrow(/already registered/);
});

it("similarityFn still throws /no similarity fn/ for unknown name after registerSimilarity calls", () => {
  expect(() => similarityFn("nope")).toThrow(/no similarity fn/);
});

// ── SimilarityFn.embeddingVersions is optional on built-ins ──────────────────

it("simJaccard has no embeddingVersions key", () => {
  expect(simJaccard.embeddingVersions).toBeUndefined();
});

it("simExact has no embeddingVersions key", () => {
  expect(simExact.embeddingVersions).toBeUndefined();
});

// ── hybridMax ─────────────────────────────────────────────────────────────────

it("hybridMax takes the max of both scores and merges embeddingVersions", () => {
  const semantic: SimilarityFn = {
    isPure: true, version: "cosine@1", embeddingVersions: { "fake-model": "v1" },
    scoreOne: () => 0.9,
  };
  const h = hybridMax(simJaccard, semantic);
  expect(h.scoreOne("NYC", "New York City")).toBe(0.9); // jaccard 0, semantic wins
  expect(h.version).toBe("hybrid-max@1[jaccard@1,cosine@1]");
  expect(h.embeddingVersions).toEqual({ "fake-model": "v1" });
});

it("hybridMax selects lexical score when it dominates", () => {
  const lowScorer: SimilarityFn = { isPure: true, version: "low@1", scoreOne: () => 0.1 };
  const h = hybridMax(simJaccard, lowScorer);
  // identical tokens → jaccard = 1, lowScorer = 0.1 → max = 1
  expect(h.scoreOne("hello world", "hello world")).toBe(1);
});

it("hybridMax isPure is AND of both operands", () => {
  const impure: SimilarityFn = { isPure: false, version: "imp@1", scoreOne: () => 0 };
  expect(hybridMax(simJaccard, impure).isPure).toBe(false);
  expect(hybridMax(simJaccard, simJaccard).isPure).toBe(true);
});

it("hybridMax version string follows exact template", () => {
  const fn: SimilarityFn = { isPure: true, version: "exact@1", scoreOne: () => 0 };
  expect(hybridMax(simJaccard, fn).version).toBe("hybrid-max@1[jaccard@1,exact@1]");
});

it("hybridMax omits embeddingVersions when neither operand has it", () => {
  const h = hybridMax(simJaccard, simExact);
  expect("embeddingVersions" in h).toBe(false);
});

it("hybridMax merges embeddingVersions from both sides when both present", () => {
  const a: SimilarityFn = {
    isPure: true, version: "a@1",
    embeddingVersions: { "model-a": "v1" },
    scoreOne: () => 0.5,
  };
  const b: SimilarityFn = {
    isPure: true, version: "b@1",
    embeddingVersions: { "model-b": "v2" },
    scoreOne: () => 0.5,
  };
  const h = hybridMax(a, b);
  expect(h.embeddingVersions).toEqual({ "model-a": "v1", "model-b": "v2" });
});

it("hybridMax degrades to the healthy scorer when one operand returns NaN", () => {
  const nanFn: SimilarityFn = { isPure: true, version: "nan@1", scoreOne: () => NaN };
  // nanFn NaN-poisons Math.max without the finite-guard; jaccard("hello","hello") = 1
  expect(hybridMax(simJaccard, nanFn).scoreOne("hello", "hello")).toBe(1);
  expect(hybridMax(nanFn, simJaccard).scoreOne("hello", "hello")).toBe(1);
});

// ── relevanceFloor ────────────────────────────────────────────────────────────

it("relevanceFloor keeps entries with score >= minScore (boundary inclusive)", () => {
  const ranked = {
    scored: [
      { claim: { value: "a" } as any, score: 0.8 },
      { claim: { value: "b" } as any, score: 0.5 },
      { claim: { value: "c" } as any, score: 0.3 },
    ],
  };
  const result = relevanceFloor(0.5)(ranked);
  expect(result.scored).toHaveLength(2);
  expect(result.scored[0].claim.value).toBe("a");
  expect(result.scored[1].claim.value).toBe("b");
});

it("relevanceFloor preserves order of surviving entries", () => {
  const ranked = {
    scored: [
      { claim: { value: "first" } as any, score: 0.9 },
      { claim: { value: "second" } as any, score: 0.7 },
      { claim: { value: "third" } as any, score: 0.6 },
    ],
  };
  const result = relevanceFloor(0.5)(ranked);
  expect(result.scored.map((s) => s.claim.value)).toEqual(["first", "second", "third"]);
});

it("relevanceFloor returns empty scored when nothing clears the floor", () => {
  const ranked = {
    scored: [
      { claim: { value: "a" } as any, score: 0.3 },
      { claim: { value: "b" } as any, score: 0.1 },
    ],
  };
  const result = relevanceFloor(0.5)(ranked);
  expect(result.scored).toHaveLength(0);
});

it("relevanceFloor throws for minScore below 0", () => {
  expect(() => relevanceFloor(-0.1)).toThrow();
});

it("relevanceFloor throws for minScore above 1", () => {
  expect(() => relevanceFloor(1.1)).toThrow();
});

it("relevanceFloor is usable as a Stage<RankedCorpus, RankedCorpus> (accepts ctx as second arg)", () => {
  // Type-level check: relevanceFloor(0.5) must be assignable to Stage<RankedCorpus, RankedCorpus>
  // We verify this at runtime by calling it with a ctx argument (it should ignore ctx)
  const stage: Stage<RankedCorpus, RankedCorpus> = relevanceFloor(0.5);
  const ranked: RankedCorpus = { scored: [{ claim: { value: "x" } as any, score: 0.8 }] };
  const fakeCtx = {} as EvalContext;
  const result = stage(ranked, fakeCtx);
  expect(result.scored).toHaveLength(1);
});
