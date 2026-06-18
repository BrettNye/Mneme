import { describe, it, expect } from "vitest";
import type { Claim } from "../../../src/core/claim.js";
import { simJaccard } from "../../../src/algebra/similarity.js";
import { rankBlend } from "./rank-blend.js";

const DAY = 86_400_000;
// Metrics read only value + valid.from; minimal claim cast.
function claim(id: string, value: string, validFrom: number): Claim {
  return { id, value, valid: { from: validFrom, to: Infinity } } as unknown as Claim;
}
const T = 1_000 * DAY; // evaluation instant
const opts = (alpha: number, halfLifeDays = 90) => ({ alpha, halfLifeMs: halfLifeDays * DAY, t: T });

describe("rankBlend", () => {
  it("alpha=1 orders by jaccard desc with STABLE input order on ties (== rho)", () => {
    const q = "blue widget";
    // c1 high jaccard, c2 & c3 zero jaccard (tie) — c2 before c3 in input must stay.
    const c1 = claim("c1", "blue widget", T - 10 * DAY);
    const c2 = claim("c2", "zzz", T - 1 * DAY);     // newer but irrelevant
    const c3 = claim("c3", "qqq", T - 5 * DAY);
    const out = rankBlend([c1, c2, c3], q, opts(1));
    expect(out.map((c) => c.id)).toEqual(["c1", "c2", "c3"]); // c1 by score; c2,c3 tie → input order
    // sanity: matches a stable jaccard sort
    expect(simJaccard.scoreOne(c1.value, q)).toBeGreaterThan(0);
  });

  it("alpha=0 orders by recency (newest first); age=0 → recency 1", () => {
    const c1 = claim("c1", "a", T - 10 * DAY);
    const c2 = claim("c2", "b", T);           // age 0
    const c3 = claim("c3", "c", T - 3 * DAY);
    const out = rankBlend([c1, c2, c3], "irrelevant", opts(0));
    expect(out.map((c) => c.id)).toEqual(["c2", "c3", "c1"]);
  });

  it("the dial works: relevant-old vs irrelevant-new swap as alpha 1→0", () => {
    const q = "blue widget";
    const relevantOld = claim("old", "blue widget", T - 200 * DAY);
    const irrelevantNew = claim("new", "zzz", T - 1 * DAY);
    const atOne = rankBlend([relevantOld, irrelevantNew], q, opts(1, 30));
    const atZero = rankBlend([relevantOld, irrelevantNew], q, opts(0, 30));
    expect(atOne[0].id).toBe("old");   // relevance wins
    expect(atZero[0].id).toBe("new");  // recency wins
  });

  it("larger half-life flattens recency differences", () => {
    const q = "irrelevant";
    const a = claim("a", "x", T - 100 * DAY);
    const b = claim("b", "y", T - 1 * DAY);
    // pure recency: b always first; but the SCORE gap shrinks with a longer half-life.
    const shortGap = (() => {
      const lambda = Math.LN2 / (30 * DAY);
      return Math.exp(-lambda * 1 * DAY) - Math.exp(-lambda * 100 * DAY);
    })();
    const longGap = (() => {
      const lambda = Math.LN2 / (365 * DAY);
      return Math.exp(-lambda * 1 * DAY) - Math.exp(-lambda * 100 * DAY);
    })();
    expect(longGap).toBeLessThan(shortGap);
    expect(rankBlend([a, b], q, opts(0, 365)).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("empty input → empty", () => {
    expect(rankBlend([], "q", opts(0.5))).toEqual([]);
  });
});
