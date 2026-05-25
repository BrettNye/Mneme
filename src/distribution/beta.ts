import type { DistributionProtocol } from "./protocol.js";
import { betaToOpinion, opinionToBeta } from "./subjective-logic.js";

type Beta = { alpha: number; beta: number };

export const betaBinding: DistributionProtocol<Beta> = {
  serialize: (d) => JSON.stringify(d),
  deserialize: (b) => JSON.parse(b) as Beta,
  canonicalize: (d) => `beta:${d.alpha}:${d.beta}`,
  mean: (d) => d.alpha / (d.alpha + d.beta),
  variance: (d) =>
    (d.alpha * d.beta) /
    ((d.alpha + d.beta) ** 2 * (d.alpha + d.beta + 1)),
  toOpinion: (d) => betaToOpinion(d.alpha, d.beta),
  fromOpinion: (o) => opinionToBeta(o),
  combine: () => {
    throw new Error(
      "combination rules are deferred to v1 (MVP supports no rules)"
    );
  },
  supportedRules: () => new Set<string>(),
  isIdempotent: () => {
    throw new Error("no rules in MVP");
  },
};
