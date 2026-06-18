import { describe, it, expect } from "vitest";
import type { Claim } from "../../../src/core/claim.js";
import type { LmeQuestionT } from "../types.js";
import {
  latestAnswerSessionId, sessionTagOf, isResolutionScorable,
  staleDeprecationCorrect, recencyTop1Correct, droppedByRanking, lineageFragmented,
} from "./drift-resolution-metrics.js";

// Minimal claim — metrics read only key, tags, valid.from, recordedSeq.
function claim(key: string, session: string, validFrom: number, recordedSeq = 0): Claim {
  return { key, tags: [`session:${session}`, "turn:0"], valid: { from: validFrom, to: Infinity }, recordedSeq } as unknown as Claim;
}

// KU question, sessions s-old (May) < s-new (Jun), both answer sessions.
const Q: LmeQuestionT = {
  question_id: "ku_1", question_type: "knowledge-update",
  question: "?", question_date: "2023/07/01 (Sat) 10:00", answer: "Y",
  sessions: [
    { sessionId: "s-old", date: "2023/05/01 (Mon) 10:00", turns: [] },
    { sessionId: "s-mid", date: "2023/05/15 (Mon) 10:00", turns: [] },
    { sessionId: "s-new", date: "2023/06/01 (Thu) 10:00", turns: [] },
  ],
  answer_session_ids: ["s-old", "s-new"],
} as unknown as LmeQuestionT;

const Q1: LmeQuestionT = { ...Q, answer_session_ids: ["s-new"] } as LmeQuestionT; // single answer session
const QNON: LmeQuestionT = { ...Q, question_type: "single-session-user" } as unknown as LmeQuestionT;

describe("latestAnswerSessionId", () => {
  it("returns the latest-dated answer session", () => {
    expect(latestAnswerSessionId(Q)).toBe("s-new");
  });
  it("null when no answer sessions", () => {
    expect(latestAnswerSessionId({ ...Q, answer_session_ids: [] } as LmeQuestionT)).toBeNull();
  });
});

describe("sessionTagOf", () => {
  it("extracts the session id", () => {
    expect(sessionTagOf(claim("employer", "s-new", 2))).toBe("s-new");
  });
});

describe("isResolutionScorable", () => {
  it("true for KU with >=2 answer sessions", () => expect(isResolutionScorable(Q)).toBe(true));
  it("false for KU with 1 answer session", () => expect(isResolutionScorable(Q1)).toBe(false));
  it("false for non-KU", () => expect(isResolutionScorable(QNON)).toBe(false));
});

describe("staleDeprecationCorrect", () => {
  it("false when a stale (non-latest) answer-session claim survives", () => {
    const survivors = [claim("employer", "s-old", 1), claim("current_employer", "s-new", 2)];
    expect(staleDeprecationCorrect(Q, survivors)).toBe(false);
  });
  it("true when only the latest answer-session claim survives", () => {
    expect(staleDeprecationCorrect(Q, [claim("employer", "s-new", 2)])).toBe(true);
  });
  it("true with multiple latest-session claims (no non-latest survivor)", () => {
    expect(staleDeprecationCorrect(Q, [claim("employer", "s-new", 2), claim("city", "s-new", 3)])).toBe(true);
  });
  it("3-session lineage: middle survivor (only oldest deprecated) → false (complete-collapse bar)", () => {
    // pairwise resolve left s-mid alive alongside s-new
    const survivors = [claim("employer", "s-mid", 2), claim("preferred_employer", "s-new", 3)];
    const Q3 = { ...Q, answer_session_ids: ["s-old", "s-mid", "s-new"] } as LmeQuestionT;
    expect(staleDeprecationCorrect(Q3, survivors)).toBe(false);
  });
  it("undefined for single-answer-session and non-KU", () => {
    expect(staleDeprecationCorrect(Q1, [])).toBeUndefined();
    expect(staleDeprecationCorrect(QNON, [])).toBeUndefined();
  });
});

describe("recencyTop1Correct (negative control)", () => {
  it("true when the newest survivor is on the latest session", () => {
    const survivors = [claim("employer", "s-old", 1000), claim("current_employer", "s-new", 2000)];
    expect(recencyTop1Correct(Q, survivors)).toBe(true);
  });
  it("false when the newest survivor is on a stale session", () => {
    const survivors = [claim("employer", "s-new", 1000), claim("x", "s-old", 5000)];
    // s-old claim has larger validFrom here → newest-by-validFrom is the stale one
    expect(recencyTop1Correct(Q, survivors)).toBe(false);
  });
  it("valid.from tie broken by recordedSeq then last-in-array (deterministic)", () => {
    const a = claim("a", "s-old", 1000, 1);
    const b = claim("b", "s-new", 1000, 2);
    expect(recencyTop1Correct(Q, [a, b])).toBe(true);  // b wins tie (higher recordedSeq, on latest)
  });
  it("false on empty survivors", () => expect(recencyTop1Correct(Q, [])).toBe(false));
});

describe("droppedByRanking", () => {
  it("true iff resolution succeeded but served (top-1) failed", () => {
    const collapsed = [claim("employer", "s-new", 2)]; // staleDeprec true
    expect(droppedByRanking(Q, collapsed, false)).toBe(true);
    expect(droppedByRanking(Q, collapsed, true)).toBe(false);
    const notCollapsed = [claim("employer", "s-old", 1), claim("v", "s-new", 2)]; // staleDeprec false
    expect(droppedByRanking(Q, notCollapsed, false)).toBe(false);
  });
  it("undefined when not scorable", () => expect(droppedByRanking(Q1, [], false)).toBeUndefined());
});

describe("lineageFragmented", () => {
  it("true when answer-session claims split a canonical group across keys", () => {
    const qClaims = [claim("employer", "s-old", 1), claim("current_employer", "s-new", 2)];
    expect(lineageFragmented(Q, qClaims, { current_employer: "employer" })).toBe(true);
  });
  it("false when answer-session claims share one key (no split)", () => {
    const qClaims = [claim("employer", "s-old", 1), claim("employer", "s-new", 2)];
    expect(lineageFragmented(Q, qClaims, {})).toBe(false);
  });
  it("undefined when not scorable", () => expect(lineageFragmented(Q1, [], {})).toBeUndefined());
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "../../../src/surface/index.js";
import { ingestQuestion } from "../ingest.js";
import { MANUAL_KEY_CARDINALITY } from "../run.js";
import { RULE } from "../../../src/distribution/rules.js";
import { resolveOnly } from "./drift-resolution-metrics.js";
import type { ClaimRecordT } from "../types.js";

describe("resolveOnly (integration)", () => {
  // alice employer Initech (s-old) → Globex (s-new); a stale claim under a drifted key.
  const QI = {
    question_id: "ro_1", question_type: "knowledge-update", question: "?",
    question_date: "2023/07/01 (Sat) 10:00", answer: "Globex",
    sessions: [
      { sessionId: "s-old", date: "2023/05/01 (Mon) 10:00", turns: [] },
      { sessionId: "s-new", date: "2023/06/01 (Thu) 10:00", turns: [] },
    ],
    answer_session_ids: ["s-old", "s-new"],
  } as unknown as LmeQuestionT;

  const records: ClaimRecordT[] = [
    { subject: "alice", key: "preferred_employer", value: "Initech", validFrom: Date.UTC(2023,4,1), tags: ["session:s-old","turn:0"] },
    { subject: "alice", key: "employer", value: "Globex", validFrom: Date.UTC(2023,5,1), tags: ["session:s-new","turn:0"] },
  ];

  function run(aliased: boolean): readonly Claim[] {
    const dir = mkdtempSync(join(tmpdir(), "drift-ro-"));
    const session = openSession({ dbPath: join(dir, "lme.db"), writer: "drift-ro", source: "imported" });
    try {
      ingestQuestion(session, QI, records);
      return resolveOnly(session, `lme-${QI.question_id}`, QI, {
        keyCardinality: MANUAL_KEY_CARDINALITY,
        keyAliases: aliased ? { preferred_employer: "employer" } : undefined,
        evidencePoolingRule: RULE.MAX_MEAN,
      });
    } finally {
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("WITHOUT aliases: stale claim survives (no ranking applied) → staleDeprec false", () => {
    const survivors = run(false);
    expect(staleDeprecationCorrect(QI, survivors)).toBe(false);
  });
  it("WITH oracle alias map: stale deprecated → staleDeprec true", () => {
    const survivors = run(true);
    expect(staleDeprecationCorrect(QI, survivors)).toBe(true);
  });
});
