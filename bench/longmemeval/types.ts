/**
 * Shared type contracts for the LongMemEval benchmark harness.
 *
 * Raw field names in `normalizeQuestion` are based on the published LongMemEval
 * dataset schema. IMPORTANT: field names MUST be re-verified against the actual
 * downloaded file before the first real run, as HuggingFace dataset field names
 * can differ from published documentation.
 */
import { z } from "zod";
import type { Claim } from "../../src/core/claim.js";

export const LmeTurn = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  has_answer: z.boolean().optional(), // turn-level evidence label
});

export const LmeSession = z.object({
  sessionId: z.string(),
  date: z.string(),
  turns: z.array(LmeTurn),
});

export const LmeQuestion = z.object({
  question_id: z.string(),
  question_type: z.string(),
  question: z.string(),
  question_date: z.string(),
  answer: z.unknown().optional(),
  sessions: z.array(LmeSession),           // the haystack
  answer_session_ids: z.array(z.string()), // session-level evidence labels
});

export type LmeQuestionT = z.infer<typeof LmeQuestion>;

/**
 * Map one raw HuggingFace LongMemEval record → normalized LmeQuestion shape.
 *
 * Expected raw fields (verify against actual download before first real run):
 *   question_id, question_type, question, answer, question_date,
 *   haystack_session_ids (string[]), haystack_dates (string[]),
 *   haystack_sessions (array of arrays of {role, content, has_answer?}),
 *   answer_session_ids (string[])
 */
export function normalizeQuestion(raw: unknown): LmeQuestionT {
  const r = raw as Record<string, unknown>;

  const sessionIds = r.haystack_session_ids as string[];
  const sessionDates = r.haystack_dates as string[];
  const haystackSessions = r.haystack_sessions as Array<Array<{
    role: string;
    content: string;
    has_answer?: boolean;
  }>>;

  if (
    sessionIds.length !== sessionDates.length ||
    sessionIds.length !== haystackSessions.length
  ) {
    throw new Error(
      `length mismatch for question_id=${r.question_id as string}: ` +
      `haystack_session_ids=${sessionIds.length}, ` +
      `haystack_dates=${sessionDates.length}, ` +
      `haystack_sessions=${haystackSessions.length}`
    );
  }

  const sessions = sessionIds.map((sessionId, i) => ({
    sessionId,
    date: sessionDates[i],
    turns: haystackSessions[i].map((turn) => ({
      role: turn.role as "user" | "assistant",
      content: turn.content,
      ...(turn.has_answer !== undefined ? { has_answer: turn.has_answer } : {}),
    })),
  }));

  return {
    question_id: r.question_id as string,
    question_type: r.question_type as string,
    question: r.question as string,
    question_date: r.question_date as string,
    answer: r.answer,
    sessions,
    answer_session_ids: (r.answer_session_ids as string[]) ?? [],
  };
}

/**
 * Parse a LongMemEval date string into epoch ms (UTC).
 *
 * Accepts the dataset's canonical format: "YYYY/MM/DD (Day) HH:MM"
 * Strips the parenthetical day-of-week, requires shape "YYYY/MM/DD HH:MM" after strip,
 * parses as UTC ("YYYY-MM-DDTHH:MM:00Z").
 * Throws an Error naming the raw string on mismatch or NaN result.
 *
 * This is the single source of truth for LME date parsing — used by answer.ts,
 * score.ts, and the converter.
 */
export function parseLmeInstant(raw: string): number {
  // Strip the parenthetical day-of-week: "2023/06/01 (Thu) 10:00" → "2023/06/01 10:00"
  const stripped = raw.replace(/\s*\([^)]*\)\s*/g, " ").trim();

  // Require shape "YYYY/MM/DD HH:MM" after strip
  const match = stripped.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error(`parseLmeInstant: unparseable date string "${raw}"`);
  }

  const [, year, month, day, hour, min] = match;
  const iso = `${year}-${month}-${day}T${hour}:${min}:00Z`;
  const ms = Date.parse(iso);

  if (Number.isNaN(ms)) {
    throw new Error(`parseLmeInstant: unparseable date string "${raw}"`);
  }

  return ms;
}

export type Category = "knowledge-update" | "temporal-reasoning" | "abstention" | "other";

/**
 * Map a question to its evaluation category.
 * `_abs`-suffixed question_ids are abstention; otherwise map question_type.
 * LongMemEval uses "knowledge-update" and "temporal-reasoning" as question_type strings;
 * anything else maps to "other".
 */
export function categoryOf(q: LmeQuestionT): Category {
  if (q.question_id.endsWith("_abs")) {
    return "abstention";
  }
  switch (q.question_type) {
    case "knowledge-update":
      return "knowledge-update";
    case "temporal-reasoning":
      return "temporal-reasoning";
    default:
      return "other";
  }
}

/** One extracted claim = one JSONL row. Provenance tags are the scoring linchpin. */
export const ClaimRecord = z.object({
  subject: z.string(),
  key: z.string(),
  value: z.string(),
  validFrom: z.number(), // epoch ms of source session date
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()),
}).refine(
  (r) => r.tags.some((t) => t.startsWith("session:")) && r.tags.some((t) => t.startsWith("turn:")),
  { message: "claim missing session:/turn: provenance tags" },
);

export type ClaimRecordT = z.infer<typeof ClaimRecord>;

/** First line of the extraction cache; mismatch => hard refuse, never silent mixing. */
export const CacheHeader = z.object({
  kind: z.literal("lme-extraction-header"),
  model: z.string(),
  promptVersion: z.string(),
});

export type CacheHeaderT = z.infer<typeof CacheHeader>;

/** What one arm returns for one question. */
export interface AnswerResult {
  arm: "A" | "B";
  claims: Claim[];   // top-k, provenance tags intact
  abstained: boolean;
}
