import type { DistributionProtocol } from "./protocol.js";
import { betaToOpinion, opinionToBeta, type SLOpinion } from "./subjective-logic.js";
import { RULE } from "./rules.js";
import { DEFAULT_PRIOR, betaMean } from "../core/confidence.js";

type Beta = { alpha: number; beta: number };

const { W, a } = DEFAULT_PRIOR;

const mean = (d: Beta): number => betaMean(d.alpha, d.beta);
const conc = (d: Beta): number => d.alpha + d.beta;

/**
 * Dempster's rule of combination for binomial (2-outcome) Subjective Logic opinions.
 * Mass functions: m(x)=belief, m(¬x)=disbelief, m(Θ)=uncertainty.
 * Conflict K = m1(x)·m2(¬x) + m1(¬x)·m2(x); normalized by 1/(1-K).
 */
function dempsterCombine(o1: SLOpinion, o2: SLOpinion): SLOpinion {
  const { belief: b1, disbelief: d1, uncertainty: u1 } = o1;
  const { belief: b2, disbelief: d2, uncertainty: u2 } = o2;

  const K = b1 * d2 + d1 * b2;
  const CONFLICT_THRESHOLD = 1 - 1e-4;

  if (K >= CONFLICT_THRESHOLD) {
    throw new Error(
      `Dempster combination failed: total conflict (K=${K.toFixed(6)} ≈ 1). ` +
        `The two opinions are maximally opposed and cannot be combined.`
    );
  }

  const norm = 1 / (1 - K);
  const combinedBelief = (b1 * b2 + b1 * u2 + u1 * b2) * norm;
  const combinedDisbelief = (d1 * d2 + d1 * u2 + u1 * d2) * norm;
  const combinedUncertainty = u1 * u2 * norm;

  return {
    belief: combinedBelief,
    disbelief: combinedDisbelief,
    uncertainty: combinedUncertainty,
    baseRate: (o1.baseRate + o2.baseRate) / 2,
  };
}

export const betaBinding: DistributionProtocol<Beta> = {
  serialize: (d) => JSON.stringify(d),
  deserialize: (b) => JSON.parse(b) as Beta,
  canonicalize: (d) => `beta:${d.alpha}:${d.beta}`,
  mean: (d) => betaMean(d.alpha, d.beta),
  variance: (d) =>
    (d.alpha * d.beta) /
    ((d.alpha + d.beta) ** 2 * (d.alpha + d.beta + 1)),
  toOpinion: (d) => betaToOpinion(d.alpha, d.beta),
  fromOpinion: (o) => opinionToBeta(o),

  combine(
    ruleId: string,
    x: Beta,
    y: Beta,
    params?: { weights?: [number, number] }
  ): Beta {
    switch (ruleId) {
      case RULE.WEIGHTED_AVG: {
        // Idempotent; one prior carried (Σw=1)
        const [wx, wy] = params?.weights ?? [1, 1];
        const s = wx + wy;
        return {
          alpha: (wx * x.alpha + wy * y.alpha) / s,
          beta: (wx * x.beta + wy * y.beta) / s,
        };
      }

      case RULE.EVIDENCE_POOLED:
        // Pairwise; exact by associativity. Subtracts one prior (W=2, a=0.5).
        return {
          alpha: x.alpha + y.alpha - a * W,
          beta: x.beta + y.beta - (1 - a) * W,
        };

      case RULE.MAX_MEAN:
        // First-arg wins on tie
        return mean(x) >= mean(y) ? x : y;

      case RULE.MAX_CONCENTRATION:
        // First-arg wins on tie
        return conc(x) >= conc(y) ? x : y;

      case RULE.DEMPSTER: {
        // Via SL mass functions + conflict normalization
        const o1 = betaToOpinion(x.alpha, x.beta);
        const o2 = betaToOpinion(y.alpha, y.beta);
        return opinionToBeta(dempsterCombine(o1, o2));
      }

      default:
        throw new Error(`rule "${ruleId}" not supported by the Beta binding`);
    }
  },

  supportedRules: () =>
    new Set<string>([
      RULE.WEIGHTED_AVG,
      RULE.EVIDENCE_POOLED,
      RULE.MAX_MEAN,
      RULE.MAX_CONCENTRATION,
      RULE.DEMPSTER,
    ]),

  isIdempotent: (ruleId: string): boolean =>
    ruleId === RULE.WEIGHTED_AVG ||
    ruleId === RULE.MAX_MEAN ||
    ruleId === RULE.MAX_CONCENTRATION,
};
