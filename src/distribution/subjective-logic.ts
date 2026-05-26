import { DEFAULT_PRIOR } from "../core/confidence.js";

export interface SLOpinion {
  belief: number;
  disbelief: number;
  uncertainty: number;
  baseRate: number;
}

export function betaToOpinion(alpha: number, beta: number, W = DEFAULT_PRIOR.W, a = DEFAULT_PRIOR.a): SLOpinion {
  const total = alpha + beta;
  return {
    belief: (alpha - a * W) / total,
    disbelief: (beta - (1 - a) * W) / total,
    uncertainty: W / total,
    baseRate: a,
  };
}

export function opinionToBeta(o: SLOpinion, W = DEFAULT_PRIOR.W): { alpha: number; beta: number } {
  if (o.uncertainty === 0) {
    throw new RangeError("opinionToBeta: uncertainty must be > 0 (a dogmatic opinion has no finite Beta equivalent)");
  }
  const total = W / o.uncertainty;
  return {
    alpha: o.belief * total + o.baseRate * W,
    beta: o.disbelief * total + (1 - o.baseRate) * W,
  };
}
