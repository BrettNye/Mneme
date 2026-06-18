/**
 * Blend ranker for the recency-aware ranking gate (bench-only).
 *
 * score = alpha·jaccard(value,query) + (1-alpha)·exp(-lambda·age),
 *   lambda = ln2/halfLifeMs, age = max(0, t - valid.from).
 * alpha=1 → pure jaccard (byte-identical to arm A's rho: stable score-only
 * sort over the same resolveOnly claim order). alpha=0 → pure age-decay recency.
 *
 * Spec: docs/superpowers/specs/2026-06-17-recency-aware-ranking-gate-design.md
 */
import type { Claim } from "../../../src/core/claim.js";
import type { Value } from "../../../src/core/value.js";
import { simJaccard } from "../../../src/algebra/similarity.js";

export interface BlendOpts { alpha: number; halfLifeMs: number; t: number }

export function rankBlend(survivors: readonly Claim[], query: Value, opts: BlendOpts): Claim[] {
  const lambda = Math.LN2 / opts.halfLifeMs;
  const scored = survivors.map((claim, i) => {
    const rel = simJaccard.scoreOne(claim.value, query);     // [0,1]
    const age = Math.max(0, opts.t - claim.valid.from);      // ≥0 (tauValid guarantees)
    const recency = Math.exp(-lambda * age);                 // (0,1], newest≈1
    const score = opts.alpha * rel + (1 - opts.alpha) * recency;
    return { claim, score, i };
  });
  // Tie-break = stable input order ONLY → alpha=1 is identical to arm A's rho.
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.claim);
}
