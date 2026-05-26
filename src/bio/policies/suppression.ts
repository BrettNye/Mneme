import { pointEstimate } from "../../core/confidence.js";
import type { Claim } from "../../core/claim.js";
import type { DecayPolicy, RetrievalContext, RetrievalPolicy } from "../types.js";

// Default decay seam until Mneme ships delta: exponential over the Beta/scalar point estimate.
export function exponentialDecay(halfLifeMs: number): DecayPolicy {
  return (c: Claim, now) => pointEstimate(c.confidence) * Math.pow(0.5, (now - c.recorded) / halfLifeMs);
}

export function suppression(opts: { floor: number }): RetrievalPolicy {
  return {
    name: "suppression",
    apply: (claims, ctx: RetrievalContext) =>
      claims.filter((c) => ctx.decay(c, ctx.now) >= opts.floor),
  };
}

export function compose(policies: RetrievalPolicy[]): RetrievalPolicy {
  return { name: "compose", apply: (claims, ctx) => policies.reduce((acc, p) => p.apply(acc, ctx), claims) };
}
