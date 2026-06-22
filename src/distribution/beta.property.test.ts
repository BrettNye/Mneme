// Property-based verification of the Beta binding + Subjective-Logic mapping.
//
// These are the AI-derived equations with the most moving parts: the β↔opinion
// bijection, Dempster's rule of combination, and evidence pooling. The existing
// beta.test.ts pins each to 1-2 hand-picked inputs. Here every law the code
// *claims* (in comments or via isIdempotent) is asserted over generated inputs.
//
// Convention (matches scalar.property.test.ts):
//   - Laws that should hold within float error      -> toBeCloseTo
//   - Claims the code states as EXACT               -> toBe  (probe: red = the
//     stated-exact claim is false under IEEE-754, which is a finding, not a bug
//     in the test)
import fc from "fast-check";
import { betaBinding } from "./beta.js";
import { betaToOpinion, opinionToBeta } from "./subjective-logic.js";
import { RULE } from "./rules.js";

// Valid-opinion domain: with DEFAULT_PRIOR {W:2,a:0.5}, a beta maps to a
// non-negative opinion iff alpha>=1 and beta>=1. Vacuous opinion == Beta(1,1).
const ab = () => fc.double({ min: 1, max: 1000, noNaN: true });
const weight = () => fc.double({ min: 0.001, max: 1000, noNaN: true });
const RUNS = 5000;
const VACUOUS = { alpha: 1, beta: 1 };
const K_THRESHOLD = 1 - 1e-4;

// Laws that hold in exact arithmetic but round under IEEE-754 hold "up to a few
// ULPs". Assert that tight bound (~16·ε·|expected|) instead of bit-equality.
const expectCloseUlp = (actual: number, expected: number, k = 16) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(k * Number.EPSILON * Math.max(1, Math.abs(expected)));

// ===========================================================================
// Subjective-Logic invariants — the bedrock the Dempster path stands on.
// ===========================================================================

it("SL: belief + disbelief + uncertainty === 1 for every valid beta", () => {
  fc.assert(
    fc.property(ab(), ab(), (alpha, beta) => {
      const o = betaToOpinion(alpha, beta);
      expect(o.belief + o.disbelief + o.uncertainty).toBeCloseTo(1, 10);
    }),
    { numRuns: RUNS }
  );
});

it("SL: opinion components are non-negative for valid beta (alpha,beta>=1)", () => {
  fc.assert(
    fc.property(ab(), ab(), (alpha, beta) => {
      const o = betaToOpinion(alpha, beta);
      expect(o.belief).toBeGreaterThanOrEqual(-1e-12);
      expect(o.disbelief).toBeGreaterThanOrEqual(-1e-12);
      expect(o.uncertainty).toBeGreaterThan(0);
    }),
    { numRuns: RUNS }
  );
});

// THE bijection. opinionToBeta∘betaToOpinion must be identity, or the whole
// Dempster round-trip (beta -> opinion -> combine -> opinion -> beta) is lossy.
it("SL: opinionToBeta(betaToOpinion(a,b)) ~= {a,b} (round-trip identity)", () => {
  fc.assert(
    fc.property(ab(), ab(), (alpha, beta) => {
      const rt = opinionToBeta(betaToOpinion(alpha, beta));
      expect(rt.alpha).toBeCloseTo(alpha, 9);
      expect(rt.beta).toBeCloseTo(beta, 9);
    }),
    { numRuns: RUNS }
  );
});

// ===========================================================================
// weighted_avg — isIdempotent claims TRUE unconditionally (same as scalar).
// ===========================================================================

// isIdempotent(weighted_avg)===true is unconditional; avg(x,x)=x mathematically for
// any weights, but only up to ULP under IEEE-754 (same float reality as scalar).
it("beta weighted_avg idempotent ~= x for arbitrary weights (up to ULP)", () => {
  fc.assert(
    fc.property(ab(), ab(), weight(), weight(), (alpha, beta, wx, wy) => {
      const r = betaBinding.combine(RULE.WEIGHTED_AVG, { alpha, beta }, { alpha, beta }, { weights: [wx, wy] });
      expectCloseUlp(r.alpha, alpha);
      expectCloseUlp(r.beta, beta);
    }),
    { numRuns: RUNS }
  );
});

// ===========================================================================
// evidence_pooled — code comment: "Pairwise; exact by associativity."
// ===========================================================================

it("evidence_pooled is commutative (exact)", () => {
  fc.assert(
    fc.property(ab(), ab(), ab(), ab(), (a1, b1, a2, b2) => {
      const xy = betaBinding.combine(RULE.EVIDENCE_POOLED, { alpha: a1, beta: b1 }, { alpha: a2, beta: b2 });
      const yx = betaBinding.combine(RULE.EVIDENCE_POOLED, { alpha: a2, beta: b2 }, { alpha: a1, beta: b1 });
      expect(xy).toEqual(yx);
    }),
    { numRuns: RUNS }
  );
});

// evidence_pooled is associative in exact arithmetic, but NOT bit-exact under
// IEEE-754 (fold order changes the result by ~1 ULP — float + isn't associative).
// This is why combineGroup sorts claims by id before folding. Assert the true law.
it("evidence_pooled is associative up to ULP (fold order drifts <=ULP)", () => {
  fc.assert(
    fc.property(ab(), ab(), ab(), ab(), ab(), ab(), (a1, b1, a2, b2, a3, b3) => {
      const x = { alpha: a1, beta: b1 }, y = { alpha: a2, beta: b2 }, z = { alpha: a3, beta: b3 };
      const left = betaBinding.combine(RULE.EVIDENCE_POOLED, betaBinding.combine(RULE.EVIDENCE_POOLED, x, y), z);
      const right = betaBinding.combine(RULE.EVIDENCE_POOLED, x, betaBinding.combine(RULE.EVIDENCE_POOLED, y, z));
      expectCloseUlp(left.alpha, right.alpha);
      expectCloseUlp(left.beta, right.beta);
    }),
    { numRuns: RUNS }
  );
});

// ===========================================================================
// Dempster's rule — the most complex AI-derived equation in the binding.
// ===========================================================================

it("dempster: combining with the vacuous opinion Beta(1,1) is identity (~=)", () => {
  fc.assert(
    fc.property(ab(), ab(), (alpha, beta) => {
      const r = betaBinding.combine(RULE.DEMPSTER, { alpha, beta }, VACUOUS);
      expect(betaBinding.mean(r)).toBeCloseTo(betaBinding.mean({ alpha, beta }), 9);
      expect(r.alpha).toBeCloseTo(alpha, 6);
      expect(r.beta).toBeCloseTo(beta, 6);
    }),
    { numRuns: RUNS }
  );
});

it("dempster is commutative for non-conflicting opinions (~=)", () => {
  fc.assert(
    fc.property(ab(), ab(), ab(), ab(), (a1, b1, a2, b2) => {
      const o1 = betaToOpinion(a1, b1), o2 = betaToOpinion(a2, b2);
      fc.pre(o1.belief * o2.disbelief + o1.disbelief * o2.belief < K_THRESHOLD);
      const xy = betaBinding.combine(RULE.DEMPSTER, { alpha: a1, beta: b1 }, { alpha: a2, beta: b2 });
      const yx = betaBinding.combine(RULE.DEMPSTER, { alpha: a2, beta: b2 }, { alpha: a1, beta: b1 });
      expect(betaBinding.mean(xy)).toBeCloseTo(betaBinding.mean(yx), 9);
    }),
    { numRuns: RUNS }
  );
});

// ===========================================================================
// Selection rules — should hold exactly (no arithmetic).
// ===========================================================================

it("beta max_mean is idempotent and associative (exact)", () => {
  fc.assert(
    fc.property(ab(), ab(), ab(), ab(), ab(), ab(), (a1, b1, a2, b2, a3, b3) => {
      const x = { alpha: a1, beta: b1 }, y = { alpha: a2, beta: b2 }, z = { alpha: a3, beta: b3 };
      expect(betaBinding.combine(RULE.MAX_MEAN, x, x)).toEqual(x);
      const left = betaBinding.combine(RULE.MAX_MEAN, betaBinding.combine(RULE.MAX_MEAN, x, y), z);
      const right = betaBinding.combine(RULE.MAX_MEAN, x, betaBinding.combine(RULE.MAX_MEAN, y, z));
      expect(betaBinding.mean(left)).toBe(betaBinding.mean(right));
    }),
    { numRuns: RUNS }
  );
});

// ===========================================================================
// Range invariants.
// ===========================================================================

it("beta mean in [0,1] and variance >= 0 for valid beta", () => {
  fc.assert(
    fc.property(ab(), ab(), (alpha, beta) => {
      const m = betaBinding.mean({ alpha, beta });
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(1);
      expect(betaBinding.variance({ alpha, beta })).toBeGreaterThanOrEqual(0);
    }),
    { numRuns: RUNS }
  );
});
