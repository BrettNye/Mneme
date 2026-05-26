import type { RankedCorpus } from "./types.js";
import { DEFAULT_PRIOR } from "../core/confidence.js";
import { claimPath, type AggregateResult, type AggValue } from "./aggregation.js";

type Beta = { alpha: number; beta: number };
const betaMean = (b: Beta) => b.alpha / (b.alpha + b.beta);

// recover raw counts from the prior-inclusive Beta, then Wilson score-interval lower bound (95%, z=1.96)
export function wilsonLowerBound(b: Beta, z = 1.96): number {
  const { W, a } = DEFAULT_PRIOR;
  const r = b.alpha - a * W;
  const s = b.beta - (1 - a) * W;
  const n = r + s;
  if (n <= 0) return 0;
  const p = r / n, z2 = z * z;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return (center - margin) / (1 + z2 / n);
}

const aggNumber = (v: AggValue): number => {
  switch (v.kind) {
    case "count": return v.n;
    case "sum": case "avg": return v.value;
    case "rate": return betaMean(v.beta);
    default: return Number((v as any).value ?? 0);
  }
};

export type ReweightFn = (score: number, value: AggValue, allValues: AggValue[]) => number;

export const reweightMultiply: ReweightFn = (s, v) => s * aggNumber(v);
export const reweightMultiplyMean: ReweightFn = (s, v) => s * (v.kind === "rate" ? betaMean(v.beta) : aggNumber(v));
export const reweightWilsonFloor: ReweightFn = (s, v) => s * (v.kind === "rate" ? wilsonLowerBound(v.beta) : aggNumber(v));
export const reweightNormalize: ReweightFn = (s, v, all) => {
  const mx = Math.max(...all.map(aggNumber));
  return mx === 0 ? s : aggNumber(v) / mx;
};
export const reweightBoost = (factor: number): ReweightFn => (s, v) => s + aggNumber(v) * factor;

export const alphaJoinAggregate =
  (aggregate: AggregateResult, joinKey: string, reweight: ReweightFn) =>
  (rc: RankedCorpus): RankedCorpus => {
    const all = [...aggregate.groups.values()].map((g) => g.value);
    const scored = rc.scored.map((sc) => {
      const k = String(claimPath(sc.claim, joinKey));
      const hit = aggregate.groups.get(k);
      return hit ? { claim: sc.claim, score: reweight(sc.score, hit.value, all) } : sc; // unmatched: keep original score
    });
    return { scored: [...scored].sort((x, y) => y.score - x.score) };
  };
