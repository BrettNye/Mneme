import { leaf, pipe, rho, tau } from "../../src/index.js";
import { pairsOf, type ContradictionPair } from "../../src/algebra/contradiction.js";
import { filterCorpus, type Corpus, type RankedCorpus } from "../../src/algebra/types.js";
import type { Session } from "../../src/surface/index.js";
import type { Claim } from "../../src/core/claim.js";
import type { LmeQuestionT, AnswerResult } from "./types.js";
import { endOfUtcDay, parseLmeInstant } from "./types.js";

/**
 * conflictThreshold is the confidence floor for ⊥ DETECTION (claims at or below it are
 * ignored by pairsOf/clustersOf — see src/algebra/contradiction.ts). It is NOT an
 * abstention threshold: abstention is structural — no claim survives the pipeline.
 */
export interface AnswerOpts { k: number; conflictThreshold?: number }

/**
 * Bench-local latest-wins resolver (candidate to upstream into src/algebra/resolution.ts).
 *
 * For each pair, deprecates the claim with the earlier valid.from.
 * Ties are broken by deprecating the lexicographically-higher claim id.
 */
export const resolveDeprecateOlder =
  (pairs: ContradictionPair[]) =>
  (corpus: Corpus): Corpus => {
    const losers = new Set<string>();
    for (const p of pairs) {
      const leftFrom = p.left.valid.from;
      const rightFrom = p.right.valid.from;
      if (leftFrom < rightFrom) {
        // left is earlier — deprecate left
        losers.add(p.left.id);
      } else if (rightFrom < leftFrom) {
        // right is earlier — deprecate right
        losers.add(p.right.id);
      } else {
        // Tie: deprecate the lexicographically-higher id
        if (p.left.id > p.right.id) {
          losers.add(p.left.id);
        } else {
          losers.add(p.right.id);
        }
      }
    }
    return {
      claims: corpus.claims.map((cl) =>
        losers.has(cl.id) ? { ...cl, status: "deprecated" as const } : cl
      ),
    };
  };

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
  const threshold = opts.conflictThreshold ?? 0.5;

  const stages = pipe(
    leaf(corpusId),
    tau.valid(t),
    (c: Corpus) => resolveDeprecateOlder(pairsOf(c, threshold))(c),
    (c: Corpus) => filterCorpus(c, (cl) => cl.status !== "deprecated"),
    rho.jaccard(q.question)
  );

  const ranked = session.mneme.query<RankedCorpus>(corpusId, stages, {
    evaluationClock: t,
  });

  const top = takeTopK(ranked, opts.k);
  return { arm: "A", claims: top, abstained: top.length === 0 };
}
