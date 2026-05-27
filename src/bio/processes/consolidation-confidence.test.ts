import { lowerBound, tierFor, rankOf, PROMOTE_TIERS } from "./consolidation-confidence.js";
import type { Confidence } from "../../core/confidence.js";

// "Thin" beta: relatively high mean (~0.83) but significant variance so the
// lower bound does NOT clear validated@0.65. Beta(5,1) has mean=0.833,
// variance≈0.020, σ≈0.141, lb ≈ 0.833 - 1.645*0.141 ≈ 0.601 < 0.65.
// (The spec sketch used Beta(2,0.0001) which has mean≈1 but near-zero
// variance — that example is inconsistent with the stated criterion;
// the intent is clearly "high mean, but uncertain enough that lb < 0.65".)
const thinHighMeanBeta: Confidence = { distribution: "beta", parameters: { alpha: 5, beta: 1 }, raw: 0.833 };

// Concentrated Beta: Beta(40,8) — mean=40/48≈0.833, very low variance so
// lb clears validated@0.65 comfortably.
const concentratedBeta: Confidence = { distribution: "beta", parameters: { alpha: 40, beta: 8 }, raw: 0.833 };

// Scalar 0.8: variance always 0 → lowerBound = mean regardless of k.
const scalar: Confidence = { distribution: "scalar", parameters: { p: 0.8 }, raw: 0.8 };

const thresholds = { provisional: 0.5, validated: 0.65 };

describe("lowerBound", () => {
  it("thin high-mean Beta: lower bound is well below the mean and does NOT clear validated@0.65", () => {
    const lb = lowerBound(thinHighMeanBeta, 1.645);
    // Well below the mean
    expect(lb).toBeLessThan(thinHighMeanBeta.parameters.alpha / (thinHighMeanBeta.parameters.alpha + (thinHighMeanBeta.parameters as any).beta));
    // Does not clear validated@0.65
    expect(lb).toBeLessThan(0.65);
    expect(tierFor(lb, thresholds)).not.toBe("validated");
  });

  it("concentrated Beta: lower bound clears validated@0.65", () => {
    const lb = lowerBound(concentratedBeta, 1.645);
    expect(lb).toBeGreaterThanOrEqual(0.65);
    expect(tierFor(lb, thresholds)).toBe("validated");
  });

  it("lowerBound is monotonic: larger k yields smaller or equal lower bound", () => {
    const lb1 = lowerBound(concentratedBeta, 1.0);
    const lb2 = lowerBound(concentratedBeta, 1.5);
    const lb3 = lowerBound(concentratedBeta, 2.0);
    expect(lb2).toBeLessThanOrEqual(lb1);
    expect(lb3).toBeLessThanOrEqual(lb2);
  });

  it("scalar claim: lowerBound equals the mean (variance = 0)", () => {
    const lb = lowerBound(scalar, 1.645);
    expect(lb).toBeCloseTo(0.8, 10);
  });

  it("lowerBound is clamped to 0 — never negative", () => {
    const lb = lowerBound(thinHighMeanBeta, 100); // extreme k
    expect(lb).toBeGreaterThanOrEqual(0);
  });
});

describe("tierFor", () => {
  it("returns validated when lb >= validated threshold", () => {
    expect(tierFor(0.65, thresholds)).toBe("validated");
    expect(tierFor(0.9, thresholds)).toBe("validated");
  });

  it("returns provisional when lb >= provisional threshold but < validated", () => {
    expect(tierFor(0.5, thresholds)).toBe("provisional");
    expect(tierFor(0.64, thresholds)).toBe("provisional");
  });

  it("returns candidate when lb < provisional threshold", () => {
    expect(tierFor(0.0, thresholds)).toBe("candidate");
    expect(tierFor(0.499, thresholds)).toBe("candidate");
  });

  it("thresholds are inclusive (>=): boundary values map to higher tier", () => {
    expect(tierFor(0.5, thresholds)).toBe("provisional");
    expect(tierFor(0.65, thresholds)).toBe("validated");
  });
});

describe("rankOf and PROMOTE_TIERS", () => {
  it("PROMOTE_TIERS orders candidate < provisional < validated", () => {
    expect(PROMOTE_TIERS.indexOf("candidate")).toBeLessThan(PROMOTE_TIERS.indexOf("provisional"));
    expect(PROMOTE_TIERS.indexOf("provisional")).toBeLessThan(PROMOTE_TIERS.indexOf("validated"));
  });

  it("rankOf returns correct ordinal for each promotion tier", () => {
    expect(rankOf("candidate")).toBe(0);
    expect(rankOf("provisional")).toBe(1);
    expect(rankOf("validated")).toBe(2);
  });
});
