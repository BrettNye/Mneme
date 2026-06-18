import type { Corpus, RankedCorpus } from "./types.js";
import type { Value } from "../core/value.js";
import type { Instant } from "../core/time.js";
import { similarityFn } from "./similarity.js";
import { multiplier } from "./decay.js";

export interface BlendOpts {
  /** Relevance↔recency weight in [0,1]. 1 = pure similarity (== rho); 0 = pure recency. */
  alpha: number;
  /** Exponential recency half-life in days (> 0). */
  halfLifeDays: number;
}

/**
 * Metadata-aware ranking: a convex blend of value-similarity and valid.from recency.
 *
 *   score(claim) = α · sim(claim.value, query)
 *                + (1−α) · multiplier({kind:"exponential", halfLifeDays}, max(0, t − claim.valid.from))
 *
 * Both terms ∈ [0,1], so score ∈ [0,1]. Pure / clock-free: `t` is a parameter (the
 * Stage wrapper supplies it from ctx). Sort: score desc, tie-break = STABLE INPUT
 * ORDER, so at α = 1 the recency term is zeroed and ordering reproduces `rho`
 * exactly over the same survivor set. A future-dated claim (valid.from > t) clamps
 * to age 0 → recency 1.
 */
export const rankBlend =
  (simName: string, query: Value, opts: BlendOpts, t: Instant) =>
  (c: Corpus): RankedCorpus => {
    if (opts.alpha < 0 || opts.alpha > 1) {
      throw new Error(`rankBlend: alpha must be in [0,1], got ${opts.alpha}`);
    }
    if (!(opts.halfLifeDays > 0)) {
      throw new Error(`rankBlend: halfLifeDays must be > 0, got ${opts.halfLifeDays}`);
    }
    const fn = similarityFn(simName); // throws /no similarity fn/ for unknown names
    const scored = c.claims.map((claim, i) => {
      const rel = fn.scoreOne(claim.value, query); // [0,1]
      const age = Math.max(0, t - claim.valid.from); // ≥ 0
      const recency = multiplier({ kind: "exponential", halfLifeDays: opts.halfLifeDays }, age); // (0,1]
      const score = opts.alpha * rel + (1 - opts.alpha) * recency;
      return { claim, score, i };
    });
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return { scored: scored.map(({ claim, score }) => ({ claim, score })) };
  };
