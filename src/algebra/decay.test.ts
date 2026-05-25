import { multiplier, delta } from "./decay.js";
import { corpusOf } from "./types.js";

const DAY = 86_400_000;

// Helper to build a minimal claim-like object for testing
function makeClaim(recorded: number, alpha: number, betaParam: number) {
  return {
    recorded,
    confidence: {
      distribution: "beta" as const,
      parameters: { alpha, beta: betaParam },
      raw: alpha / (alpha + betaParam),
    },
  } as any;
}

// ── multiplier unit tests ────────────────────────────────────────────────────

it("none policy always returns 1 regardless of age", () => {
  expect(multiplier({ kind: "none" }, 0)).toBe(1);
  expect(multiplier({ kind: "none" }, 999 * DAY)).toBe(1);
});

it("exponential decay halves multiplier at exactly one half-life", () => {
  const halfLifeDays = 30;
  expect(multiplier({ kind: "exponential", halfLifeDays }, halfLifeDays * DAY)).toBeCloseTo(0.5);
});

it("exponential decay reaches 0.25 at two half-lives", () => {
  const halfLifeDays = 30;
  expect(multiplier({ kind: "exponential", halfLifeDays }, 2 * halfLifeDays * DAY)).toBeCloseTo(0.25);
});

it("exponential decay is 1 at age 0", () => {
  expect(multiplier({ kind: "exponential", halfLifeDays: 30 }, 0)).toBeCloseTo(1);
});

it("linear decay reaches 0 at the full-decay age (ratePerDay * days = 1)", () => {
  // ratePerDay = 0.01 → full decay at 100 days
  expect(multiplier({ kind: "linear", ratePerDay: 0.01 }, 100 * DAY)).toBeCloseTo(0);
});

it("linear decay never goes below 0", () => {
  expect(multiplier({ kind: "linear", ratePerDay: 0.01 }, 200 * DAY)).toBe(0);
});

it("linear decay is 1 at age 0", () => {
  expect(multiplier({ kind: "linear", ratePerDay: 0.01 }, 0)).toBeCloseTo(1);
});

it("step decay is 1 before the threshold and 0 on/after it", () => {
  const thresholdDays = 7;
  // just before threshold: full multiplier
  expect(multiplier({ kind: "step", thresholdDays }, (thresholdDays - 1) * DAY)).toBe(1);
  // at threshold: zero
  expect(multiplier({ kind: "step", thresholdDays }, thresholdDays * DAY)).toBe(0);
  // well after threshold: zero
  expect(multiplier({ kind: "step", thresholdDays }, (thresholdDays + 10) * DAY)).toBe(0);
});

// ── delta operator tests ─────────────────────────────────────────────────────

it("delta with none policy sets effective equal to pointEstimate and leaves parameters intact", () => {
  const cl = makeClaim(0, 9, 1); // alpha=9, beta=1 → pointEstimate = 0.9
  const corpus = corpusOf([cl]);
  const out = delta({ kind: "none" }, DAY)(corpus).claims[0];
  expect(out.confidence.effective).toBeCloseTo(0.9);
  expect(out.confidence.parameters).toEqual({ alpha: 9, beta: 1 });
});

it("delta with exponential policy halves effective at one half-life and leaves stored params intact", () => {
  const cl = makeClaim(0, 9, 1); // pointEstimate = 0.9
  const out = delta({ kind: "exponential", halfLifeDays: 30 }, 30 * DAY)(corpusOf([cl])).claims[0];
  expect(out.confidence.effective).toBeCloseTo(0.45); // 0.9 * 0.5
  expect(out.confidence.parameters).toEqual({ alpha: 9, beta: 1 }); // stored unchanged
});

it("delta with step policy gives full effective before threshold and zero after", () => {
  const cl = makeClaim(0, 9, 1); // pointEstimate = 0.9
  // 6 days old, threshold = 7 → multiplier = 1
  const outBefore = delta({ kind: "step", thresholdDays: 7 }, 6 * DAY)(corpusOf([cl])).claims[0];
  expect(outBefore.confidence.effective).toBeCloseTo(0.9);

  // 8 days old → multiplier = 0
  const outAfter = delta({ kind: "step", thresholdDays: 7 }, 8 * DAY)(corpusOf([cl])).claims[0];
  expect(outAfter.confidence.effective).toBeCloseTo(0);
});

it("delta sets effective field without mutating the original corpus claim", () => {
  const cl = makeClaim(0, 9, 1);
  const corpus = corpusOf([cl]);
  const out = delta({ kind: "exponential", halfLifeDays: 30 }, 30 * DAY)(corpus);
  // Original corpus should be untouched (no effective set)
  expect((corpus.claims[0].confidence as any).effective).toBeUndefined();
  // Output corpus has effective set
  expect(out.claims[0].confidence.effective).toBeCloseTo(0.45);
});

// ── negative age (future-recorded / clock skew) regression tests ────────────

it("multiplier returns 1 for none policy when age is negative", () => {
  expect(multiplier({ kind: "none" }, -DAY)).toBe(1);
});

it("multiplier returns 1 for exponential policy when age is negative", () => {
  expect(multiplier({ kind: "exponential", halfLifeDays: 30 }, -DAY)).toBe(1);
});

it("multiplier returns 1 for linear policy when age is negative", () => {
  expect(multiplier({ kind: "linear", ratePerDay: 0.01 }, -DAY)).toBe(1);
});

it("multiplier returns 1 for step policy when age is negative", () => {
  expect(multiplier({ kind: "step", thresholdDays: 7 }, -DAY)).toBe(1);
});

it("downstream filter on effective>0.7 respects decayed values", () => {
  // pointEstimate = 0.9, after 1 half-life → effective = 0.45 (below 0.7)
  const clDecayed = makeClaim(0, 9, 1);
  // pointEstimate = 0.9, age=0 → effective = 0.9 (above 0.7)
  const clFresh = makeClaim(30 * DAY, 9, 1);

  const corpus = corpusOf([clDecayed, clFresh]);
  const decayedCorpus = delta({ kind: "exponential", halfLifeDays: 30 }, 30 * DAY)(corpus);

  const filtered = decayedCorpus.claims.filter(
    (c) => (c.confidence.effective ?? 0) > 0.7
  );
  expect(filtered).toHaveLength(1);
  expect(filtered[0].confidence.effective).toBeCloseTo(0.9);
});
