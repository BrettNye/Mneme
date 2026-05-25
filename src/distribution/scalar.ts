import type { DistributionProtocol } from "./protocol.js";

type Scalar = { p: number };

export const scalarBinding: DistributionProtocol<Scalar> = {
  serialize: (d) => JSON.stringify(d),
  deserialize: (b) => JSON.parse(b) as Scalar,
  canonicalize: (d) => `scalar:${d.p}`,
  mean: (d) => d.p,
  variance: () => 0,
  combine: () => {
    throw new Error("combination rules are deferred to v1 (MVP supports no rules)");
  },
  supportedRules: () => new Set<string>(),
  isIdempotent: () => {
    throw new Error("no rules in MVP");
  },
};
