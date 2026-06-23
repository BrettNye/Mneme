/**
 * Confidence-aware blend ranker for the confidence-aware serving instrument
 * (bench-only). Extends the recency blend (rank-blend.ts) with a confidence
 * term:
 *   score = wSim·jaccard(value,query) + wRec·exp(-lambda·age) + wConf·conf,
 *   wSim = (1-wConf)·alpha, wRec = (1-wConf)·(1-alpha), lambda = ln2/halfLifeMs.
 * At wConf=0 this reduces EXACTLY to bench rankBlend (the recency baseline,
 * itself byte-identical to arm A at alpha=1) — the load-bearing identity gate.
 *
 * Spec: docs/superpowers/specs/2026-06-22-confidence-aware-serving-design.md
 */
import type { Claim } from "../../../src/core/claim.js";
import type { Value } from "../../../src/core/value.js";
import { simJaccard } from "../../../src/algebra/similarity.js";
import { pointEstimate } from "../../../src/core/confidence.js";

export interface BlendConfOpts { alpha: number; halfLifeMs: number; wConf: number; t: number }

export function rankBlendConf(survivors: readonly Claim[], query: Value, opts: BlendConfOpts): Claim[] {
  const lambda = Math.LN2 / opts.halfLifeMs;
  const wSim = (1 - opts.wConf) * opts.alpha;
  const wRec = (1 - opts.wConf) * (1 - opts.alpha);
  const scored = survivors.map((claim, i) => {
    const rel = simJaccard.scoreOne(claim.value, query);     // [0,1]
    const age = Math.max(0, opts.t - claim.valid.from);      // ≥0
    const recency = Math.exp(-lambda * age);                 // (0,1]
    const conf = pointEstimate(claim.confidence);            // [0,1]
    const score = wSim * rel + wRec * recency + opts.wConf * conf;
    return { claim, score, i };
  });
  // Tie-break = stable input order ONLY (identical to bench rankBlend / arm A rho).
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((s) => s.claim);
}
