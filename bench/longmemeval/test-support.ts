/**
 * Shared test helpers for the LongMemEval benchmark harness.
 *
 * Mirrors the src/bio/test-support.ts precedent — pure construction helpers
 * plus a tmp-DB session. No assertions, no network I/O, no side effects beyond
 * the tmp dir.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSession, type Session } from "../../src/surface/index.js";
import type { Claim } from "../../src/core/claim.js";
import type { LmeQuestionT, AnswerResult, ClaimRecordT } from "./types.js";

// ---------------------------------------------------------------------------
// Tmp-DB session
// ---------------------------------------------------------------------------

/**
 * Open a Session backed by a fresh SQLite database in a system tmp dir.
 * Call close() in afterEach — it shuts down the adapter and deletes the dir.
 */
export function openTmpSession(): { session: Session; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mneme-lme-"));
  const session = openSession({
    dbPath: join(dir, "lme.db"),
    writer: "lme-test",
    source: "imported",
  });
  return {
    session,
    close: () => {
      session.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort — Windows may delay release */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Format a Date as a LongMemEval dataset date string: "2023/06/01 (Thu) 10:00" */
function lmeDate(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  const dow = days[d.getUTCDay()];
  const hour = pad(d.getUTCHours());
  const min = pad(d.getUTCMinutes());
  return `${year}/${month}/${day} (${dow}) ${hour}:${min}`;
}

// ---------------------------------------------------------------------------
// Question builders
// ---------------------------------------------------------------------------

/** Minimal LmeTurn list. */
function turns(content: string): { role: "user" | "assistant"; content: string }[] {
  return [
    { role: "user", content: content },
    { role: "assistant", content: "Got it." },
  ];
}

/**
 * Build a knowledge-update question.
 * evidence: haystack session ids that are answer sessions (default: ["sess-ku-1"]).
 * questionDate: LME date string for the question (default: after the evidence sessions).
 */
export function kuQuestion(
  opts?: { evidence?: string[]; questionDate?: string }
): LmeQuestionT {
  const evidence = opts?.evidence ?? ["sess-ku-1"];
  const questionDate = opts?.questionDate ?? "2023/12/01 (Fri) 10:00";
  // Build one session per evidence id; non-evidence sessions get a dummy session
  const allSessionIds = [...evidence, "sess-ku-bkg"];
  const sessions = allSessionIds.map((sid) => ({
    sessionId: sid,
    date: evidence.includes(sid)
      ? "2023/06/01 (Thu) 10:00"
      : "2023/01/01 (Sun) 10:00",
    turns: turns(`User's employer changed — see ${sid}.`),
  }));
  return {
    question_id: "ku-001",
    question_type: "knowledge-update",
    question: "Where does the user work now?",
    question_date: questionDate,
    answer: "Globex",
    sessions,
    answer_session_ids: evidence,
  };
}

/**
 * Build a temporal-reasoning question.
 */
export function temporalQuestion(opts?: { evidence?: string[] }): LmeQuestionT {
  const evidence = opts?.evidence ?? ["sess-tr-1"];
  const allSessionIds = [...evidence, "sess-tr-bkg"];
  const sessions = allSessionIds.map((sid) => ({
    sessionId: sid,
    date: "2023/03/15 (Wed) 09:00",
    turns: turns(`Temporal info in ${sid}.`),
  }));
  return {
    question_id: "tr-001",
    question_type: "temporal-reasoning",
    question: "When did the user last change jobs?",
    question_date: "2023/12/01 (Fri) 10:00",
    answer: "June 2023",
    sessions,
    answer_session_ids: evidence,
  };
}

/**
 * Build an abstention question (question_id ends with _abs).
 */
export function abstentionQuestion(): LmeQuestionT {
  return {
    question_id: "abs-001_abs",
    question_type: "single-session-user",
    question: "What is the user's middle name?",
    question_date: "2023/12/01 (Fri) 10:00",
    answer: undefined,
    sessions: [
      {
        sessionId: "sess-abs-1",
        date: "2023/05/10 (Wed) 14:00",
        turns: turns("Discussed hobbies."),
      },
    ],
    answer_session_ids: [],
  };
}

// ---------------------------------------------------------------------------
// Claim/record builders
// ---------------------------------------------------------------------------

/**
 * Build a ClaimRecordT (satisfies the ClaimRecord schema) with optional overrides.
 * Default tags include "session:default-sess" and "turn:0" to satisfy the schema.
 */
export function claimRecord(over?: Partial<ClaimRecordT>): ClaimRecordT {
  const defaults: ClaimRecordT = {
    subject: "test-subject",
    key: "employer",
    value: "Initech",
    validFrom: new Date("2023-01-01T00:00:00Z").getTime(),
    confidence: 0.9,
    tags: ["session:default-sess", "turn:0"],
  };
  return { ...defaults, ...over };
}

/**
 * Build a full Claim object with the supplied session/turn provenance tags.
 * Fills sensible defaults for all required fields; applies `over` last.
 */
export function claimTagged(
  sessionTag: string,
  turnTag: string,
  over?: Partial<Claim>
): Claim {
  const base: Claim = {
    id: `claim-${sessionTag}-${turnTag}` as Claim["id"],
    profile: "lme-test" as Claim["profile"],
    workspace: "lme-test-ws" as Claim["workspace"],
    subject: "test-subject",
    key: "employer",
    scope: {},
    scopeHash: "_",
    value: "Initech",
    valueHash: "deadbeef01234567",
    confidence: { distribution: "scalar", parameters: { p: 0.9 }, raw: 0.9 },
    valid: { from: new Date("2023-01-01T00:00:00Z").getTime(), to: Infinity },
    recorded: 0, // epoch 0 — deterministic sentinel; not a real ingestion time
    recordedSeq: 0,
    status: "validated",
    source: "imported",
    provenance: {},
    evidence: [],
    audience: {},
    tags: [`session:${sessionTag}`, `turn:${turnTag}`],
    schema: "lme-test@1",
  };
  return { ...base, ...over };
}

/**
 * Build an AnswerResult for the given arm, claims, and optional abstention flag.
 */
export function armResult(
  arm: "A" | "B",
  claims: Claim[],
  abstained = false
): AnswerResult {
  return { arm, claims, abstained };
}

// ---------------------------------------------------------------------------
// Seeded corpus fixture
// ---------------------------------------------------------------------------

/**
 * Open a tmp session, create a corpus with always_accept contradiction policy,
 * and write a superseding pair of claims (Initech → Globex for same subject+key).
 * Returns the session, close fn, corpusId, and a matching kuQuestion.
 *
 * The two claims share subject="employer" and key="employer", but different values
 * and ascending valid.from. The question date is after both valid.from values.
 */
export function seedSupersedingPair(): {
  session: Session;
  close: () => void;
  corpusId: string;
  q: LmeQuestionT;
} {
  const { session, close } = openTmpSession();
  const corpusId = "lme-supersede-test";

  session.createCorpus({
    id: corpusId,
    contradictionPolicy: { kind: "always_accept" },
  });

  // Earlier claim: Initech (valid.from = Jan 2023)
  const fromInitech = new Date("2023-01-01T10:00:00Z").getTime();
  session.write(corpusId, {
    subject: "employer",
    key: "employer",
    value: "Initech",
    valid: { from: fromInitech, to: Infinity },
    tags: ["session:sess-ku-1", "turn:0"],
    confidence: 0.8,
  });

  // Later claim: Globex (valid.from = Jun 2023)
  const fromGlobex = new Date("2023-06-01T10:00:00Z").getTime();
  session.write(corpusId, {
    subject: "employer",
    key: "employer",
    value: "Globex",
    valid: { from: fromGlobex, to: Infinity },
    tags: ["session:sess-ku-2", "turn:0"],
    confidence: 0.9,
  });

  // Build a kuQuestion whose sessions have dates matching the claims
  const q: LmeQuestionT = {
    question_id: "ku-supersede-001",
    question_type: "knowledge-update",
    question: "Where does the user work now?",
    question_date: lmeDate(new Date("2023-12-01T10:00:00Z")),
    answer: "Globex",
    sessions: [
      {
        sessionId: "sess-ku-1",
        date: lmeDate(new Date(fromInitech)),
        turns: turns("I work at Initech."),
      },
      {
        sessionId: "sess-ku-2",
        date: lmeDate(new Date(fromGlobex)),
        turns: turns("I moved to Globex."),
      },
    ],
    answer_session_ids: ["sess-ku-2"],
  };

  return { session, close, corpusId, q };
}

// ---------------------------------------------------------------------------
// Fixture path helper
// ---------------------------------------------------------------------------

/**
 * Resolve an absolute path into the committed fixtures directory
 * (`bench/longmemeval/fixtures/<name>`). Used by integration tests that load
 * small sample files checked into the repo.
 */
export function fixturePath(name: string): string {
  // __dirname is not available in ESM; derive from import.meta.url
  const dir = fileURLToPath(new URL("./fixtures", import.meta.url));
  return join(dir, name);
}
