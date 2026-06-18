import { rankBlend } from "./ranking.js";
import { corpusOf } from "./types.js";

const DAY = 86_400_000;
const T = 1_700_000_000_000; // evaluation instant

// Minimal claim-like objects: rankBlend only reads `value` and `valid.from`.
const mk = (value: string, fromTs: number) =>
  ({ value, valid: { from: fromTs, to: Infinity } } as any);

// ── alpha = 1: pure similarity, identical ordering to a stable jaccard sort ──

it("alpha=1 ranks purely by similarity (recency term zeroed)", () => {
  const corpus = corpusOf([
    mk("the quick brown fox", T - 100 * DAY), // old but exact match
    mk("hello world", T),                     // new but irrelevant
  ]);
  const out = rankBlend("jaccard", "the quick brown fox", { alpha: 1, halfLifeDays: 90 }, T)(corpus);
  expect(out.scored[0].claim.value).toBe("the quick brown fox");
  expect(out.scored[0].score).toBeCloseTo(1); // pure jaccard exact match
});

it("alpha=1 preserves stable input order on an equal-score tie (rho identity)", () => {
  // Two claims with identical value → identical jaccard score → tie.
  const corpus = corpusOf([
    mk("same value", T - 50 * DAY), // newer would win if recency leaked in
    mk("same value", T - 10 * DAY),
  ]);
  const out = rankBlend("jaccard", "same value", { alpha: 1, halfLifeDays: 90 }, T)(corpus);
  // Stable input order: first input stays first despite being older.
  expect(out.scored[0].claim.valid.from).toBe(T - 50 * DAY);
  expect(out.scored[1].claim.valid.from).toBe(T - 10 * DAY);
});

// ── alpha = 0: pure recency ──

it("alpha=0 orders by recency (newest valid.from first)", () => {
  const corpus = corpusOf([
    mk("a", T - 100 * DAY),
    mk("b", T - 10 * DAY),
    mk("c", T - 200 * DAY),
  ]);
  const out = rankBlend("jaccard", "irrelevant", { alpha: 0, halfLifeDays: 90 }, T)(corpus);
  expect(out.scored.map((s) => s.claim.value)).toEqual(["b", "a", "c"]);
});

it("alpha=0: a claim at the evaluation instant gets recency score 1", () => {
  const corpus = corpusOf([mk("x", T)]);
  const out = rankBlend("jaccard", "anything", { alpha: 0, halfLifeDays: 90 }, T)(corpus);
  expect(out.scored[0].score).toBeCloseTo(1);
});

// ── the dial actually trades relevance for recency ──

it("dial swaps a relevant-old and irrelevant-new claim as alpha goes 1 -> 0", () => {
  const corpus = corpusOf([
    mk("the quick brown fox", T - 200 * DAY), // relevant, old
    mk("zzz qqq", T),                         // irrelevant, brand new
  ]);
  const atOne = rankBlend("jaccard", "the quick brown fox", { alpha: 1, halfLifeDays: 90 }, T)(corpus);
  const atZero = rankBlend("jaccard", "the quick brown fox", { alpha: 0, halfLifeDays: 90 }, T)(corpus);
  expect(atOne.scored[0].claim.value).toBe("the quick brown fox"); // relevance wins
  expect(atZero.scored[0].claim.value).toBe("zzz qqq");            // recency wins
});

// ── half-life flattens recency differences ──

it("larger half-life flattens the recency gap between two ages", () => {
  const corpus = corpusOf([mk("p", T - 90 * DAY)]);
  const shortHl = rankBlend("jaccard", "p", { alpha: 0, halfLifeDays: 90 }, T)(corpus);
  const longHl = rankBlend("jaccard", "p", { alpha: 0, halfLifeDays: 3650 }, T)(corpus);
  // At 90d age: hl=90 → recency=0.5; hl=3650 → recency≈0.983. Longer hl ⇒ closer to 1.
  expect(shortHl.scored[0].score).toBeCloseTo(0.5);
  expect(longHl.scored[0].score).toBeGreaterThan(shortHl.scored[0].score);
});

// ── future-dated claim clamps to recency 1 ──

it("a future-dated claim (valid.from > t) clamps to recency 1, no negative age", () => {
  const corpus = corpusOf([mk("future", T + 30 * DAY)]);
  const out = rankBlend("jaccard", "nope", { alpha: 0, halfLifeDays: 90 }, T)(corpus);
  expect(out.scored[0].score).toBeCloseTo(1);
});

// ── validation + edges ──

it("throws when alpha is outside [0,1]", () => {
  const corpus = corpusOf([mk("x", T)]);
  expect(() => rankBlend("jaccard", "q", { alpha: 1.5, halfLifeDays: 90 }, T)(corpus)).toThrow(/alpha/);
  expect(() => rankBlend("jaccard", "q", { alpha: -0.1, halfLifeDays: 90 }, T)(corpus)).toThrow(/alpha/);
});

it("throws when halfLifeDays is not > 0", () => {
  const corpus = corpusOf([mk("x", T)]);
  expect(() => rankBlend("jaccard", "q", { alpha: 0.5, halfLifeDays: 0 }, T)(corpus)).toThrow(/halfLifeDays/);
});

it("throws for an unknown similarity fn name", () => {
  const corpus = corpusOf([mk("x", T)]);
  expect(() => rankBlend("nope-fn", "q", { alpha: 0.5, halfLifeDays: 90 }, T)(corpus)).toThrow(/no similarity fn/);
});

it("returns empty scored for an empty corpus", () => {
  const out = rankBlend("jaccard", "q", { alpha: 0.5, halfLifeDays: 90 }, T)(corpusOf([]));
  expect(out.scored).toHaveLength(0);
});
