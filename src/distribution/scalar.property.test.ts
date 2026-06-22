// Property-based verification of the scalar binding's algebraic laws.
//
// The existing scalar.test.ts pins each "law" to a single hand-picked input
// (e.g. idempotence at p=0.7, weights=[1,1] — a power-of-two divisor, the most
// float-friendly case possible). These tests instead assert each law the code
// *claims* (via isIdempotent / the rule semantics) over thousands of generated
// inputs, so a counterexample the chosen examples can't reach will surface.
//
// Laws asserted match what the implementation actually claims:
//   - idempotence: all 3 supported rules (isIdempotent === true for each)
//   - commutativity: weighted_avg (equal weights) and max_mean ONLY
//   - associativity: max_mean and max_concentration ONLY (weighted_avg is
//     deliberately non-associative — asserting it would be a false law)
//   - closure: weighted_avg stays in [0,1] for inputs in [0,1], positive weights
import fc from "fast-check";
import { scalarBinding } from "./scalar.js";
import { RULE } from "./rules.js";

const S = (p: number) => ({ p });
const p01 = () => fc.double({ min: 0, max: 1, noNaN: true });
const weight = () => fc.double({ min: 0.001, max: 1000, noNaN: true });
const RUNS = 5000;

// A law that holds in exact arithmetic but rounds under IEEE-754 holds "up to a few
// ULPs". Assert that tight bound (~16·ε·|expected|) instead of bit-equality: still
// catches real (larger-than-rounding) regressions, but accepts unavoidable float
// rounding. ε = 2.22e-16, so for |expected|<=1 the bound is ~3.6e-15.
const expectCloseUlp = (actual: number, expected: number, k = 16) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(k * Number.EPSILON * Math.max(1, Math.abs(expected)));

// ---------------------------------------------------------------------------
// Idempotence — combine(rule, x, x) === x.  The code asserts isIdempotent=true
// for all three rules, so this must hold for ALL p, not just p=0.7.
// ---------------------------------------------------------------------------

it("max_mean is idempotent for all p (exact)", () => {
  fc.assert(
    fc.property(p01(), (p) => {
      expect(scalarBinding.combine(RULE.MAX_MEAN, S(p), S(p)).p).toBe(p);
    }),
    { numRuns: RUNS }
  );
});

it("max_concentration is idempotent for all p (exact)", () => {
  fc.assert(
    fc.property(p01(), (p) => {
      expect(scalarBinding.combine(RULE.MAX_CONCENTRATION, S(p), S(p)).p).toBe(p);
    }),
    { numRuns: RUNS }
  );
});

it("weighted_avg is idempotent for all p at default weights [1,1] (exact)", () => {
  fc.assert(
    fc.property(p01(), (p) => {
      const r = scalarBinding.combine(RULE.WEIGHTED_AVG, S(p), S(p), { weights: [1, 1] });
      expect(r.p).toBe(p);
    }),
    { numRuns: RUNS }
  );
});

it("weighted_avg is idempotent for all p at equal weights [w,w] (up to ULP)", () => {
  fc.assert(
    fc.property(p01(), weight(), (p, w) => {
      const r = scalarBinding.combine(RULE.WEIGHTED_AVG, S(p), S(p), { weights: [w, w] });
      expectCloseUlp(r.p, p);
    }),
    { numRuns: RUNS }
  );
});

// isIdempotent(weighted_avg) === true is UNCONDITIONAL, and mathematically avg(x,x)=x
// for ANY weights — but only up to ULP under IEEE-754 with unequal weights (e.g.
// p=0.7, [2,5] -> 0.7000000000000001). Exact bit-equality only holds at power-of-two
// weight sums like [1,1]; this asserts the true (ULP-bounded) law.
it("weighted_avg is idempotent for all p at arbitrary weights [wx,wy] (up to ULP)", () => {
  fc.assert(
    fc.property(p01(), weight(), weight(), (p, wx, wy) => {
      const r = scalarBinding.combine(RULE.WEIGHTED_AVG, S(p), S(p), { weights: [wx, wy] });
      expectCloseUlp(r.p, p);
    }),
    { numRuns: RUNS }
  );
});

// Self-merge drifts by <=ULP, so the canonical STRING is NOT bit-stable
// (scalar:0.7 vs scalar:0.7000000000000001). Accepted by design: confidence is never
// hashed (audit covers event metadata only — sqlite.ts canonicalEvent) and replay
// compares within epsilon. We assert only that the underlying value is ULP-stable.
it("weighted_avg self-merge is value-stable up to ULP (canonical string may differ)", () => {
  fc.assert(
    fc.property(p01(), weight(), weight(), (p, wx, wy) => {
      const merged = scalarBinding.combine(RULE.WEIGHTED_AVG, S(p), S(p), { weights: [wx, wy] });
      expectCloseUlp(merged.p, p);
    }),
    { numRuns: RUNS }
  );
});

// ---------------------------------------------------------------------------
// Commutativity — only where the rule claims it.
// ---------------------------------------------------------------------------

it("max_mean is commutative for all x,y", () => {
  fc.assert(
    fc.property(p01(), p01(), (a, b) => {
      const xy = scalarBinding.combine(RULE.MAX_MEAN, S(a), S(b));
      const yx = scalarBinding.combine(RULE.MAX_MEAN, S(b), S(a));
      expect(xy).toEqual(yx);
    }),
    { numRuns: RUNS }
  );
});

it("weighted_avg is commutative at equal weights for all x,y", () => {
  fc.assert(
    fc.property(p01(), p01(), (a, b) => {
      const xy = scalarBinding.combine(RULE.WEIGHTED_AVG, S(a), S(b), { weights: [1, 1] });
      const yx = scalarBinding.combine(RULE.WEIGHTED_AVG, S(b), S(a), { weights: [1, 1] });
      expect(xy.p).toBe(yx.p);
    }),
    { numRuns: RUNS }
  );
});

// ---------------------------------------------------------------------------
// Associativity — max_mean (it's max) and max_concentration (it's leftmost).
// NOT weighted_avg (deliberately non-associative).
// ---------------------------------------------------------------------------

it("max_mean is associative for all a,b,c", () => {
  fc.assert(
    fc.property(p01(), p01(), p01(), (a, b, c) => {
      const left = scalarBinding.combine(
        RULE.MAX_MEAN,
        scalarBinding.combine(RULE.MAX_MEAN, S(a), S(b)),
        S(c)
      );
      const right = scalarBinding.combine(
        RULE.MAX_MEAN,
        S(a),
        scalarBinding.combine(RULE.MAX_MEAN, S(b), S(c))
      );
      expect(left.p).toBe(right.p);
    }),
    { numRuns: RUNS }
  );
});

it("max_concentration is associative for all a,b,c", () => {
  fc.assert(
    fc.property(p01(), p01(), p01(), (a, b, c) => {
      const left = scalarBinding.combine(
        RULE.MAX_CONCENTRATION,
        scalarBinding.combine(RULE.MAX_CONCENTRATION, S(a), S(b)),
        S(c)
      );
      const right = scalarBinding.combine(
        RULE.MAX_CONCENTRATION,
        S(a),
        scalarBinding.combine(RULE.MAX_CONCENTRATION, S(b), S(c))
      );
      expect(left.p).toBe(right.p);
    }),
    { numRuns: RUNS }
  );
});

// ---------------------------------------------------------------------------
// Closure — weighted_avg of inputs in [0,1] with positive weights stays in [0,1].
// ---------------------------------------------------------------------------

it("weighted_avg result stays in [0,1] for inputs in [0,1], positive weights", () => {
  fc.assert(
    fc.property(p01(), p01(), weight(), weight(), (a, b, wx, wy) => {
      const r = scalarBinding.combine(RULE.WEIGHTED_AVG, S(a), S(b), { weights: [wx, wy] });
      expect(r.p).toBeGreaterThanOrEqual(0);
      expect(r.p).toBeLessThanOrEqual(1);
    }),
    { numRuns: RUNS }
  );
});
