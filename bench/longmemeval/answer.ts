import { leaf, pipe, rho, tau } from "../../src/index.js";
import { pairsOf } from "../../src/algebra/contradiction.js";
import { oplusDedupe } from "../../src/algebra/combination.js";
import { filterCorpus, type Corpus, type RankedCorpus } from "../../src/algebra/types.js";
import { resolveDeprecateOlder, CONTRADICTION_FLAG_KEY } from "../../src/algebra/resolution.js";
import { relevanceFloor, abstainBelowTop } from "../../src/algebra/similarity.js";
import type { Session } from "../../src/surface/index.js";
import type { Claim } from "../../src/core/claim.js";
import type { LmeQuestionT, AnswerResult } from "./types.js";
import { endOfUtcDay, parseLmeInstant } from "./types.js";

/**
 * conflictThreshold is the confidence ELIGIBILITY floor for ⊥ detection (claims at or
 * below it are excluded from pairsOf/clustersOf — see src/algebra/contradiction.ts).
 * Default 0 = corpus default (session.createCorpus): all claims are eligible to contest.
 * It is NOT an abstention threshold: abstention is structural — no claim survives the pipeline.
 */
export interface AnswerOpts {
  k: number;
  /** ⊥ eligibility floor; default 0 = corpus default (session.createCorpus). */
  conflictThreshold?: number;
  /** Per-key cardinality map forwarded to detection (additive keys never contest). */
  keyCardinality?: Record<string, "single" | "multi">;
  /** Jaccard cutoff for the dedupe stage — a measured dial. Default 0.5. */
  dedupeCutoff?: number;
  /** Registered similarity fn for ranking; default "jaccard" — never probes the registry. */
  rankFn?: string;
  /** Abstention knob (all-or-nothing on weak TOP match): if top score is strictly below this,
   *  the entire result is discarded (abstained). Default 0 = off.
   *  Applied BEFORE relevanceFloor — abstention is decided on the raw ranked corpus, never
   *  the floor-filtered one. */
  abstainBelowTop?: number;
  /** Precision knob (per-entry): filters individual entries whose score is below this value.
   *  Default 0 = disabled (filter is >=). */
  relevanceFloor?: number;
}

/**
 * Parse question_date → epoch ms. Delegates to parseLmeInstant (single source of truth).
 *
 * Handles format: "2023/06/01 (Thu) 10:00"
 * Normalises to UTC epoch ms.
 */
export function questionInstant(q: LmeQuestionT): number {
  return parseLmeInstant(q.question_date);
}

/**
 * Return the epoch ms of the end of the question_date's UTC day (23:59:59.999Z).
 *
 * LongMemEval question timestamps have same-day granularity: evidence sessions are
 * frequently timestamped later on the same calendar day as the question. The question
 * is asked "at the end of this day's history" — same-day later sessions represent
 * facts the agent already knows, while genuinely future facts (the next day or later)
 * remain excluded.
 *
 * armA uses this as both the τ_valid cutoff and the evaluationClock.
 */
export function evaluationInstant(q: LmeQuestionT): number {
  const dayStart = parseLmeInstant(q.question_date);
  return endOfUtcDay(dayStart);
}

/** top-k is bench-local and trivial: ranked.scored.slice(0, k).map(s => s.claim). */
function takeTopK(ranked: RankedCorpus, k: number): Claim[] {
  return ranked.scored.slice(0, k).map((s) => s.claim);
}

/**
 * Arm B: plain recall, no resolution. Built as a minimal Stage[] (leaf → rho.jaccard)
 * via mneme.query rather than DSL string interpolation. Never abstains; superseded
 * values surface alongside current ones.
 */
export function answerArmB(
  session: Session,
  corpusId: string,
  q: LmeQuestionT,
  opts: AnswerOpts
): AnswerResult {
  const ranked = session.mneme.query<RankedCorpus>(
    corpusId,
    pipe(leaf(corpusId), rho.jaccard(q.question))
  );
  return { arm: "B", claims: takeTopK(ranked, opts.k), abstained: false };
}

/**
 * Arm A: τ_valid(question date) → ⊥ detect → latest-wins resolve → drop deprecated → rank → top-k.
 *
 * Uses τ_valid (valid-interval filter) rather than τ_known (valid ∩ recorded) so the
 * pipeline works both in production (where claims carry historical `recorded` timestamps)
 * and in tests (where claims are committed at wall-clock time). The acceptance criterion
 * specifies that claims with `valid.from` after the question date are excluded — which is
 * exactly the τ_valid predicate.
 */
export function answerArmA(
  session: Session,
  corpusId: string,
  q: LmeQuestionT,
  opts: AnswerOpts
): AnswerResult {
  // Use end-of-day as the evaluation instant: LongMemEval question timestamps have
  // same-day granularity, so evidence sessions later the same calendar day are known.
  const t = evaluationInstant(q);
  const threshold = opts.conflictThreshold ?? 0;
  const cutoff = opts.dedupeCutoff ?? 0.5;

  // Default rankFn is pinned to "jaccard" — arm A never probes the registry.
  // Callers that want hybrid must register it AND pass rankFn: "hybrid" explicitly.
  const rankFn = opts.rankFn ?? "jaccard";

  const stages = pipe(
    leaf(corpusId),
    tau.valid(t),
    (c: Corpus) => oplusDedupe("rule_weighted_avg", undefined,
      { similarity: { fn: "jaccard", cutoff } })(c),
    (c: Corpus) => resolveDeprecateOlder(pairsOf(c, threshold, { keyCardinality: opts.keyCardinality }))(c),
    (c: Corpus) => filterCorpus(c, (cl) => cl.status !== "deprecated" && cl.key !== CONTRADICTION_FLAG_KEY),
    rho.by(rankFn, q.question),
    // Order is contractual: abstainBelowTop MUST run before relevanceFloor — abstention is
    // decided on the raw ranked corpus, never the floor-filtered one.
    (r: RankedCorpus) => abstainBelowTop(opts.abstainBelowTop ?? 0)(r),
    (r: RankedCorpus) => relevanceFloor(opts.relevanceFloor ?? 0)(r)
  );

  const ranked = session.mneme.query<RankedCorpus>(corpusId, stages, {
    evaluationClock: t,
  });

  const top = takeTopK(ranked, opts.k);
  return { arm: "A", claims: top, abstained: top.length === 0 };
}
