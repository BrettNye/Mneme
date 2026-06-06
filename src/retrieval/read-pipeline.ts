/**
 * Named compositions of algebra operators — the canonical read pipeline.
 *
 * Layering contract: this module imports FROM algebra; algebra NEVER imports FROM retrieval.
 * Permitted: import from ../mneme.js (rho.by builder; records provenance versions).
 */
import type { Stage } from "../algebra/expression.js";
import type { Corpus, RankedCorpus } from "../algebra/types.js";
import { filterCorpus } from "../algebra/types.js";
import type { Value } from "../core/value.js";
import { tauValid } from "../algebra/temporal.js";
import { oplusDedupe } from "../algebra/combination.js";
import { pairsOf } from "../algebra/contradiction.js";
import { resolveDeprecateOlder, CONTRADICTION_FLAG_KEY } from "../algebra/resolution.js";
import { abstainBelowTop, relevanceFloor } from "../algebra/similarity.js";
import { rho } from "../mneme.js";

// ── canonicalReadStages ───────────────────────────────────────────────────────

export interface ReadPipelineOpts {
  /** Epoch ms used as τ_valid cut-off and ⊥ evaluation instant. */
  evaluationInstant: number;
  /** Per-key cardinality map forwarded to contradiction detection.
   *  Keys mapped "multi" are excluded from cluster formation entirely. */
  keyCardinality?: Record<string, "single" | "multi">;
  /** Confidence ELIGIBILITY floor for ⊥ detection.
   *  Claims with eff(claim) <= threshold cannot contest.
   *  Default 0 — all claims are eligible. */
  conflictThreshold?: number;
  /** Dedupe similarity config.
   *  Defaults: fn="jaccard", cutoff=0.5, rule="rule_weighted_avg".
   *  `rule` field is RESERVED for future use. */
  dedupe?: { fn: string; cutoff: number; rule?: string };
}

/**
 * Canonical read-side core (canonical spec §4.8, reified):
 *   τ_valid(t) → ⊕_dedupe → ⊥(keyCardinality, floor)/resolveDeprecateOlder → drop deprecated + flags
 *
 * Returns a Stage<Corpus, Corpus>[] that callers prepend leaf/σ to.
 *
 * Defaults:
 *   - conflictThreshold: 0
 *   - dedupe fn: "jaccard", cutoff: 0.5, rule: "rule_weighted_avg"
 */
export function canonicalReadStages(opts: ReadPipelineOpts): Stage<Corpus, Corpus>[] {
  const t = opts.evaluationInstant;
  const threshold = opts.conflictThreshold ?? 0;
  const dedupeFn = opts.dedupe?.fn ?? "jaccard";
  const dedupeCutoff = opts.dedupe?.cutoff ?? 0.5;

  return [
    // 1. τ_valid: exclude claims whose valid interval does not cover t
    (c: Corpus) => tauValid(t)(c),

    // 2. ⊕_dedupe: merge token-overlap restatements (default: jaccard@0.5, rule_weighted_avg)
    (c: Corpus) => oplusDedupe("rule_weighted_avg", undefined, {
      similarity: { fn: dedupeFn, cutoff: dedupeCutoff },
    })(c),

    // 3. ⊥ / resolveDeprecateOlder: detect contradictions, deprecate the older claim in each pair
    (c: Corpus) => resolveDeprecateOlder(
      pairsOf(c, threshold, { keyCardinality: opts.keyCardinality }),
    )(c),

    // 4. Drop deprecated claims and contradiction flag artifacts
    (c: Corpus) => filterCorpus(
      c,
      (cl) => cl.status !== "deprecated" && cl.key !== CONTRADICTION_FLAG_KEY,
    ),
  ];
}

// ── rankedTailStages ──────────────────────────────────────────────────────────

export interface RankedTailOpts {
  /** Registered similarity fn name for ranking (e.g. "jaccard"). */
  rankFn: string;
  /** Query value to score claims against. */
  query: Value;
  /** Abstention threshold: if top score STRICTLY below this, the entire result is empty.
   *  Default 0 = off (never abstain). Applied BEFORE relevanceFloor. */
  abstainBelowTop?: number;
  /** Per-entry precision floor: entries with score below this are dropped.
   *  Default 0 = off (keep all). Applied AFTER abstainBelowTop. */
  relevanceFloor?: number;
}

/**
 * Ranking tail recipe:
 *   rho.by(rankFn, query) → abstainBelowTop → relevanceFloor
 *
 * Ordering contract: abstention is decided on the RAW ranked corpus (immediately
 * after rho), BEFORE the per-entry floor. Both knobs default to 0 (off).
 */
export function rankedTailStages(opts: RankedTailOpts): Stage<any, any>[] {
  const abstainThreshold = opts.abstainBelowTop ?? 0;
  const floorThreshold = opts.relevanceFloor ?? 0;

  return [
    // 1. ρ: rank by similarity fn (records provenance versions via rho.by from mneme.js)
    rho.by(opts.rankFn, opts.query),

    // 2. abstainBelowTop: if top score strictly < threshold, return empty corpus
    (r: RankedCorpus) => abstainBelowTop(abstainThreshold)(r),

    // 3. relevanceFloor: drop per-entry scores below floor
    (r: RankedCorpus) => relevanceFloor(floorThreshold)(r),
  ];
}
