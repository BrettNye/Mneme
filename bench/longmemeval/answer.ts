import { leaf, pipe, rho, tau } from "../../src/index.js";
import { pairsOf, type ContradictionPair } from "../../src/algebra/contradiction.js";
import { filterCorpus, type Corpus, type RankedCorpus } from "../../src/algebra/types.js";
import type { Session } from "../../src/surface/index.js";
import type { Claim } from "../../src/core/claim.js";
import type { LmeQuestionT, AnswerResult } from "./types.js";

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
 * Parse question_date → epoch ms. V8's Date.parse happens to accept the dataset's
 * "(Thu)"-style parenthetical (treated as a comment) but that is NON-STANDARD —
 * guard with Number.isNaN and throw naming the raw string.
 *
 * Handles format: "2023/06/01 (Thu) 10:00"
 * Normalises to: "2023-06-01T10:00:00Z" for deterministic UTC parsing.
 */
export function questionInstant(q: LmeQuestionT): number {
  const raw = q.question_date;

  // Strip the parenthetical day-of-week: "2023/06/01 (Thu) 10:00" → "2023/06/01 10:00"
  const stripped = raw.replace(/\s*\([^)]*\)\s*/g, " ").trim();

  // Convert slashes to dashes and append :00Z for UTC: "2023/06/01 10:00" → "2023-06-01T10:00:00Z"
  // Expected shape after strip: "YYYY/MM/DD HH:MM"
  const match = stripped.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error(
      `questionInstant: unparseable question_date "${raw}"`
    );
  }

  const [, year, month, day, hour, min] = match;
  const iso = `${year}-${month}-${day}T${hour}:${min}:00Z`;
  const ms = Date.parse(iso);

  if (Number.isNaN(ms)) {
    throw new Error(
      `questionInstant: unparseable question_date "${raw}"`
    );
  }

  return ms;
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
  const t = questionInstant(q);
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
