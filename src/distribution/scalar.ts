import { RULE } from "./rules.js";
import type { DistributionProtocol } from "./protocol.js";

type Scalar = { p: number };

export const scalarBinding: DistributionProtocol<Scalar> = {
  serialize: (d) => JSON.stringify(d),
  deserialize: (b) => JSON.parse(b) as Scalar,
  canonicalize: (d) => `scalar:${d.p}`,
  mean: (d) => d.p,
  variance: () => 0,
  combine(ruleId: string, x: Scalar, y: Scalar, params?: unknown): Scalar {
    const p = params as { weights?: [number, number] } | undefined;
    switch (ruleId) {
      case RULE.WEIGHTED_AVG: {
        const [wx, wy] = p?.weights ?? [1, 1];
        return { p: (wx * x.p + wy * y.p) / (wx + wy) };
      }
      case RULE.MAX_MEAN:
        return x.p >= y.p ? x : y;
      case RULE.MAX_CONCENTRATION:
        // degenerate: all scalars share variance 0 → tie; first-arg wins (operator pre-sorts by claim id)
        return x;
      default:
        throw new Error(`rule "${ruleId}" not supported by the scalar binding (needs an evidence total)`);
    }
  },
  supportedRules: () => new Set<string>([RULE.WEIGHTED_AVG, RULE.MAX_MEAN, RULE.MAX_CONCENTRATION]),
  isIdempotent: (ruleId: string) =>
    ruleId === RULE.WEIGHTED_AVG || ruleId === RULE.MAX_MEAN || ruleId === RULE.MAX_CONCENTRATION,
};
