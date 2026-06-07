import type { Session, ImportStats, WriteRecord } from "../../src/surface/index.js";
import type { Source } from "../../src/core/claim.js";
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
 * Optional hooks for `ingestQuestion` — extend behavior without forking.
 * No-hooks behavior is byte-identical; passing `undefined` is equivalent to
 * calling the original function with no fourth argument.
 */
export interface IngestHooks {
  /** Per-source pseudocount overrides threaded into `session.createCorpus`. */
  scalarPseudocount?: Partial<Record<Source, number>>;
  /**
   * Map the default WriteRecord before write — e.g. promote confidence to Beta.
   * Receives the ClaimRecordT and the base WriteRecord built by `mapClaimRecord`;
   * returns the WriteRecord that will be written.
   */
  mapRecord?: (rec: ClaimRecordT, base: WriteRecord) => WriteRecord;
}

/**
 * Thrown when `ingestQuestion` is called for a question whose corpus already
 * exists in the session. Session has no deleteCorpus, so re-ingesting into an
 * existing corpus would silently double-write claims. The correct workflow for
 * this bench is one fresh tmp DB per run; callers must not retry ingestion into
 * the same session.
 */
export class AlreadyIngestedError extends Error {
  constructor(public readonly corpusId: string) {
    super(
      `AlreadyIngestedError: corpus "${corpusId}" already exists in this session. ` +
        `Use a fresh tmp DB per run — re-ingesting would double-write claims.`
    );
    this.name = "AlreadyIngestedError";
  }
}

/**
 * Thrown when the number of committed claims does not equal the number of
 * records passed to `ingestQuestion`. The message includes the question id,
 * the delta (records - committed), and the duplicate count for diagnosability.
 * A non-zero duplicate count means corrupted input — fixture/extraction records
 * are expected to be unique.
 */
export class IngestConservationError extends Error {
  constructor(
    public readonly questionId: string,
    public readonly delta: number,
    public readonly records: number,
    public readonly committed: number,
    public readonly duplicate: number = 0
  ) {
    super(
      `IngestConservationError for question ${questionId}: ` +
        `expected ${records} committed, got ${committed} (delta=${delta}, duplicate=${duplicate})`
    );
    this.name = "IngestConservationError";
  }
}

/**
 * Ingest the given ClaimRecordT array into a fresh corpus for the question.
 * Creates a corpus with id `lme-<question_id>` and `contradictionPolicy: { kind: "always_accept" }`
 * so contradictions are retained for arm A's read-time resolution.
 *
 * **Re-ingest guard:** throws `AlreadyIngestedError` if the corpus already
 * exists. Session has no deleteCorpus, so this bench requires one fresh tmp DB
 * per run. Re-ingesting into an existing corpus would double-write claims and
 * could falsely satisfy conservation checks.
 *
 * **Conservation:** throws `IngestConservationError` if
 * `stats.committed !== records.length`. A non-zero `stats.duplicate` count in
 * the error indicates corrupted input — fixture/extraction records are expected
 * to be unique; duplicates are a signal of bad input, not a benign skip.
 */
export function ingestQuestion(
  session: Session,
  q: LmeQuestionT,
  records: ClaimRecordT[],
  hooks?: IngestHooks
): ImportStats {
  const corpusId = corpusIdFor(q.question_id);

  const existing = session.listCorpora();
  if (existing.some((c) => c.id === corpusId)) {
    throw new AlreadyIngestedError(corpusId);
  }

  session.createCorpus({
    id: corpusId,
    contradictionPolicy: { kind: "always_accept" },
    ...(hooks?.scalarPseudocount !== undefined && {
      scalarPseudocount: hooks.scalarPseudocount,
    }),
  });

  const writeRecords = records.map((rec) => {
    const base = mapClaimRecord(rec);
    return hooks?.mapRecord ? hooks.mapRecord(rec, base) : base;
  });
  const stats = session.writeMany(corpusId, writeRecords);

  if (stats.committed !== records.length) {
    throw new IngestConservationError(
      q.question_id,
      records.length - stats.committed,
      records.length,
      stats.committed,
      stats.duplicate
    );
  }

  return stats;
}
