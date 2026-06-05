import {
  categoryOf,
  type Category,
  type LmeQuestionT,
  type AnswerResult,
} from "./types.js";
import type { Claim } from "../../src/core/claim.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QuestionScore {
  questionId: string;
  category: Category;
  arm: "A" | "B";
  /** k → fraction of evidence sessions covered in top-k claims */
  evidenceRecallAt: Record<number, number>;
  /** KU only: top surviving claim traces to the LATEST evidence session */
  updateCorrect?: boolean;
  /** temporal only: no retrieved claim postdates question_date AND right-period evidence present */
  temporalCorrect?: boolean;
  /** abstention only: result.abstained === true */
  abstentionCorrect?: boolean;
}

export interface ScoreRow {
  category: Category;
  arm: "A" | "B";
  metric: string;
  value: number;
  n: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse an LME date string ("YYYY/MM/DD (Day) HH:MM") into epoch ms.
 * Throws with a descriptive message if Date.parse returns NaN.
 */
function parseLmeDate(raw: string): number {
  // Convert "2023/06/01 (Thu) 10:00" → "2023-06-01T10:00:00Z"
  // Strip the day-of-week annotation, replace slashes, append UTC offset.
  const cleaned = raw.replace(/\s*\([^)]+\)\s*/, " ").trim();
  // cleaned = "2023/06/01 10:00"
  const iso = cleaned.replace(/\//g, "-").replace(" ", "T") + ":00Z";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`parseLmeDate: cannot parse date string "${raw}"`);
  }
  return ms;
}

/**
 * Returns the session id (from answer_session_ids) that has the maximum date
 * among q.sessions. When dates tie, the last occurrence in answer_session_ids wins.
 */
function latestEvidenceSessionId(q: LmeQuestionT): string | null {
  if (q.answer_session_ids.length === 0) return null;

  // Build a map from sessionId → epoch ms for quick lookup
  const dateMap = new Map<string, number>();
  for (const sess of q.sessions) {
    dateMap.set(sess.sessionId, parseLmeDate(sess.date));
  }

  let latestId: string | null = null;
  let latestMs = -Infinity;

  for (const sid of q.answer_session_ids) {
    const ms = dateMap.get(sid);
    if (ms === undefined) continue;
    // Use >= so that the LAST occurrence in answer_session_ids wins on a tie
    if (ms >= latestMs) {
      latestMs = ms;
      latestId = sid;
    }
  }
  return latestId;
}

/**
 * Extract the session id from a claim tag "session:<id>", or null if absent.
 */
function sessionIdOfClaim(claim: Claim): string | null {
  const tag = claim.tags.find((t) => t.startsWith("session:"));
  return tag ? tag.slice("session:".length) : null;
}

// ---------------------------------------------------------------------------
// Exported helper
// ---------------------------------------------------------------------------

/**
 * Return the set of evidence session ids (from q.answer_session_ids) that are
 * represented anywhere in r.claims (via session: provenance tags).
 */
export function evidenceSessionsHit(
  r: AnswerResult,
  q: LmeQuestionT
): Set<string> {
  const evidenceSet = new Set(q.answer_session_ids);
  const hit = new Set<string>();
  for (const claim of r.claims) {
    const sid = sessionIdOfClaim(claim);
    if (sid !== null && evidenceSet.has(sid)) {
      hit.add(sid);
    }
  }
  return hit;
}

/**
 * Compute evidenceRecallAt for the first k claims for each k in ks.
 * Returns {} when answer_session_ids is empty (no division by zero).
 */
function computeEvidenceRecallAt(
  r: AnswerResult,
  q: LmeQuestionT,
  ks: number[]
): Record<number, number> {
  if (q.answer_session_ids.length === 0) return {};

  const evidenceSet = new Set(q.answer_session_ids);
  const total = evidenceSet.size;
  const result: Record<number, number> = {};

  for (const k of ks) {
    const topK = r.claims.slice(0, k);
    const hit = new Set<string>();
    for (const claim of topK) {
      const sid = sessionIdOfClaim(claim);
      if (sid !== null && evidenceSet.has(sid)) {
        hit.add(sid);
      }
    }
    result[k] = hit.size / total;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Core scoring function
// ---------------------------------------------------------------------------

export function scoreQuestion(
  q: LmeQuestionT,
  r: AnswerResult,
  ks: number[]
): QuestionScore {
  const category = categoryOf(q);

  const evidenceRecallAt = computeEvidenceRecallAt(r, q, ks);

  // updateCorrect — KU only
  let updateCorrect: boolean | undefined;
  if (category === "knowledge-update") {
    const latestId = latestEvidenceSessionId(q);
    if (latestId === null || r.claims.length === 0) {
      updateCorrect = false;
    } else {
      const topSessionId = sessionIdOfClaim(r.claims[0]);
      updateCorrect = topSessionId === latestId;
    }
  }

  // temporalCorrect — temporal-reasoning only
  let temporalCorrect: boolean | undefined;
  if (category === "temporal-reasoning") {
    const questionMs = parseLmeDate(q.question_date);

    // Build session date lookup
    const dateMap = new Map<string, number>();
    for (const sess of q.sessions) {
      dateMap.set(sess.sessionId, parseLmeDate(sess.date));
    }

    const evidenceSet = new Set(q.answer_session_ids);

    // false if ANY claim traces to a session whose date postdates question_date
    let hasPostdated = false;
    let hasEvidenceHit = false;

    for (const claim of r.claims) {
      const sid = sessionIdOfClaim(claim);
      if (sid === null) continue;
      const sessMs = dateMap.get(sid);
      if (sessMs !== undefined && sessMs > questionMs) {
        hasPostdated = true;
      }
      if (evidenceSet.has(sid)) {
        hasEvidenceHit = true;
      }
    }

    temporalCorrect = !hasPostdated && hasEvidenceHit;
  }

  // abstentionCorrect — abstention only
  let abstentionCorrect: boolean | undefined;
  if (category === "abstention") {
    abstentionCorrect = r.abstained === true;
  }

  return {
    questionId: q.question_id,
    category,
    arm: r.arm,
    evidenceRecallAt,
    updateCorrect,
    temporalCorrect,
    abstentionCorrect,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function aggregate(rows: QuestionScore[], ks: number[]): ScoreRow[] {
  // Group by category × arm × metric
  const groups = new Map<string, { sum: number; n: number; category: Category; arm: "A" | "B"; metric: string }>();

  function addValue(
    category: Category,
    arm: "A" | "B",
    metric: string,
    value: number
  ): void {
    const key = `${category}|${arm}|${metric}`;
    const existing = groups.get(key);
    if (existing) {
      existing.sum += value;
      existing.n += 1;
    } else {
      groups.set(key, { sum: value, n: 1, category, arm, metric });
    }
  }

  for (const row of rows) {
    const { category, arm, evidenceRecallAt, updateCorrect, temporalCorrect, abstentionCorrect } = row;

    // recall@k metrics
    for (const k of ks) {
      const val = evidenceRecallAt[k];
      if (val !== undefined) {
        addValue(category, arm, `recall@${k}`, val);
      }
    }

    // updateCorrect
    if (updateCorrect !== undefined) {
      addValue(category, arm, "updateCorrect", updateCorrect ? 1 : 0);
    }

    // temporalCorrect
    if (temporalCorrect !== undefined) {
      addValue(category, arm, "temporalCorrect", temporalCorrect ? 1 : 0);
    }

    // abstentionCorrect
    if (abstentionCorrect !== undefined) {
      addValue(category, arm, "abstentionCorrect", abstentionCorrect ? 1 : 0);
    }
  }

  // Build output rows, skip combos with n === 0 (none can exist here due to addValue logic)
  const result: ScoreRow[] = [];
  for (const { sum, n, category, arm, metric } of groups.values()) {
    if (n === 0) continue;
    result.push({ category, arm, metric, value: sum / n, n });
  }

  return result;
}
