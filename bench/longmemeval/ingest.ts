import type { Session, ImportStats, WriteRecord } from "../../src/surface/index.js";
import type { ClaimRecordT, LmeQuestionT } from "./types.js";

/** Derive the corpus ID for a given LongMemEval question. */
export function corpusIdFor(questionId: string): string {
  return `lme-${questionId}`;
}

/**
 * Filter the claims cache to the claims that belong to the given question's
 * haystack. In oracle mode (`opts.oracle === true`), only claims from sessions
 * listed in `q.answer_session_ids` are returned; otherwise all claims from any
 * session in `q.sessions` are returned.
 *
 * Membership is determined by the `session:<id>` tag on each claim record.
 */
export function claimsFor(
  q: LmeQuestionT,
  all: ClaimRecordT[],
  opts?: { oracle?: boolean }
): ClaimRecordT[] {
  const haystackIds = new Set(q.sessions.map((s) => s.sessionId));
  const evidenceIds = new Set(q.answer_session_ids);
  const allowedIds = opts?.oracle ? evidenceIds : haystackIds;

  return all.filter((rec) =>
    rec.tags.some((tag) => {
      if (!tag.startsWith("session:")) return false;
      const sessionId = tag.slice("session:".length);
      return allowedIds.has(sessionId);
    })
  );
}

/**
 * Map a ClaimRecordT to a WriteRecord for use with Session.writeMany / Session.write.
 * The shape mirrors src/surface/import.ts's RowMapper so a future direct-file path
 * can reuse importFile without re-mapping. Confidence is omitted when undefined so
 * Session.defaultConfidence applies.
 */
export function mapClaimRecord(rec: ClaimRecordT): WriteRecord {
  const base: WriteRecord = {
    subject: rec.subject,
    key: rec.key,
    value: rec.value,
    valid: { from: rec.validFrom, to: Infinity },
    tags: rec.tags,
  };
  if (rec.confidence !== undefined) {
    base.confidence = rec.confidence;
  }
  return base;
}

/**
 * Thrown when the number of committed claims does not equal the number of
 * records passed to `ingestQuestion`. The message includes the question id
 * and the delta (records - committed).
 */
export class IngestConservationError extends Error {
  constructor(
    public readonly questionId: string,
    public readonly delta: number,
    public readonly records: number,
    public readonly committed: number
  ) {
    super(
      `IngestConservationError for question ${questionId}: ` +
        `expected ${records} committed, got ${committed} (delta=${delta})`
    );
    this.name = "IngestConservationError";
  }
}

/**
 * Ingest the given ClaimRecordT array into a fresh corpus for the question.
 * Creates a corpus with id `lme-<question_id>` and `contradictionPolicy: { kind: "always_accept" }`
 * so contradictions are retained for arm A's read-time resolution.
 *
 * Conservation is enforced: throws IngestConservationError if
 * `stats.committed !== records.length`.
 */
export function ingestQuestion(
  session: Session,
  q: LmeQuestionT,
  records: ClaimRecordT[]
): ImportStats {
  const corpusId = corpusIdFor(q.question_id);

  session.createCorpus({
    id: corpusId,
    contradictionPolicy: { kind: "always_accept" },
  });

  const writeRecords = records.map(mapClaimRecord);
  const stats = session.writeMany(corpusId, writeRecords);

  if (stats.committed !== records.length) {
    throw new IngestConservationError(
      q.question_id,
      records.length - stats.committed,
      records.length,
      stats.committed
    );
  }

  return stats;
}
