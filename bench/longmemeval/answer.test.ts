import { describe, it, expect } from "vitest";
import { answerArmA, answerArmB, questionInstant, evaluationInstant } from "./answer.js";
import { seedSupersedingPair, openTmpSession } from "./test-support.js";
import type { Claim } from "../../src/core/claim.js";
import { CONTRADICTION_FLAG_KEY } from "../../src/algebra/resolution.js";

// Helper to extract the string value from a claim
function valueOf(cl: Claim): unknown {
  return cl.value;
}

// ---------------------------------------------------------------------------
// Main acceptance: superseding pair
// ---------------------------------------------------------------------------

it("arm A resolves a superseding pair to the later value; arm B returns both", () => {
  const { session, close, corpusId, q } = seedSupersedingPair(); // "Initech" then "Globex"
  const a = answerArmA(session, corpusId, q, { k: 5 });
  const b = answerArmB(session, corpusId, q, { k: 5 });
  expect(a.claims.map(valueOf)).toEqual(["Globex"]);
  expect(b.claims.map(valueOf)).toEqual(expect.arrayContaining(["Initech", "Globex"]));
  close();
});

// ---------------------------------------------------------------------------
// τ_known: future claim excluded by arm A, included by arm B
// ---------------------------------------------------------------------------

it("arm A excludes a claim whose valid.from is after question_date; arm B includes it", () => {
  const { session, close, corpusId, q } = seedSupersedingPair();

  // Add a claim with valid.from in 2024 (after q.question_date of 2023-12)
  session.write(corpusId, {
    subject: "employer",
    key: "employer",
    value: "FutureCorp",
    valid: { from: new Date("2024-01-01T10:00:00Z").getTime(), to: Infinity },
    tags: ["session:sess-ku-3", "turn:0"],
    confidence: 0.9,
  });

  const a = answerArmA(session, corpusId, q, { k: 10 });
  const b = answerArmB(session, corpusId, q, { k: 10 });

  const aValues = a.claims.map(valueOf);
  const bValues = b.claims.map(valueOf);

  // Arm A must not include FutureCorp (τ_known filters it)
  expect(aValues).not.toContain("FutureCorp");
  // Arm B must include FutureCorp (no temporal filter)
  expect(bValues).toContain("FutureCorp");
  close();
});

// ---------------------------------------------------------------------------
// Abstention: arm A abstains when no claim survives; arm B never abstains
// ---------------------------------------------------------------------------

it("arm A abstains when corpus is empty; arm B returns abstained:false", () => {
  const { session, close } = openTmpSession();
  const corpusId = "lme-empty-test";
  session.createCorpus({ id: corpusId, contradictionPolicy: { kind: "always_accept" } });

  const q = {
    question_id: "empty-001",
    question_type: "knowledge-update",
    question: "Where does the user work?",
    question_date: "2023/12/01 (Fri) 10:00",
    answer: undefined,
    sessions: [],
    answer_session_ids: [],
  };

  const a = answerArmA(session, corpusId, q, { k: 5 });
  const b = answerArmB(session, corpusId, q, { k: 5 });

  expect(a.abstained).toBe(true);
  expect(a.claims).toHaveLength(0);
  expect(b.abstained).toBe(false);
  close();
});

// ---------------------------------------------------------------------------
// Tie semantics: arm A returns BOTH tied values and no contradiction flag artifact
// ---------------------------------------------------------------------------

it("arm A returns both tied values and no flag artifact in ranked results", () => {
  const { session, close } = openTmpSession();
  const corpusId = "lme-tie-test";
  session.createCorpus({ id: corpusId, contradictionPolicy: { kind: "always_accept" } });

  // Seed a tied pair: same subject+key, conflicting values, SAME valid.from
  const tiedFrom = new Date("2023-06-01T10:00:00Z").getTime();
  session.write(corpusId, {
    subject: "user",
    key: "favorite_coffee",
    value: "flat white",
    valid: { from: tiedFrom, to: Infinity },
    tags: ["session:tie-sess-1", "turn:0"],
    confidence: 0.9,
  });
  session.write(corpusId, {
    subject: "user",
    key: "favorite_coffee",
    value: "cortado",
    valid: { from: tiedFrom, to: Infinity },
    tags: ["session:tie-sess-2", "turn:0"],
    confidence: 0.9,
  });

  const q = {
    question_id: "tie-001",
    question_type: "knowledge-update",
    question: "What is the user's favorite coffee drink, flat white or cortado?",
    question_date: "2023/12/01 (Fri) 10:00",
    answer: undefined,
    sessions: [],
    answer_session_ids: [],
  };

  const a = answerArmA(session, corpusId, q, { k: 5 });
  // Both values must survive (neither deprecated)
  expect(a.claims.map(valueOf)).toEqual(expect.arrayContaining(["flat white", "cortado"]));
  // The contradiction flag artifact must NOT appear in ranked results
  expect(a.claims.some((c) => c.key === CONTRADICTION_FLAG_KEY)).toBe(false);
  close();
});

// ---------------------------------------------------------------------------
// questionInstant
// ---------------------------------------------------------------------------

describe("questionInstant", () => {
  it("parses the dataset format '2023/06/01 (Thu) 10:00' to epoch ms", () => {
    const q = {
      question_id: "qi-001",
      question_type: "knowledge-update",
      question: "test",
      question_date: "2023/06/01 (Thu) 10:00",
      answer: undefined,
      sessions: [],
      answer_session_ids: [],
    };
    const result = questionInstant(q);
    // Expected: 2023-06-01T10:00:00Z
    expect(result).toBe(new Date("2023-06-01T10:00:00Z").getTime());
    expect(Number.isNaN(result)).toBe(false);
  });

  it("throws — naming the raw string — on an unparseable date", () => {
    const q = {
      question_id: "qi-bad",
      question_type: "knowledge-update",
      question: "test",
      question_date: "not-a-date",
      answer: undefined,
      sessions: [],
      answer_session_ids: [],
    };
    expect(() => questionInstant(q)).toThrow("not-a-date");
  });
});

// ---------------------------------------------------------------------------
// evaluationInstant
// ---------------------------------------------------------------------------

describe("evaluationInstant", () => {
  it("returns epoch of 2023-05-28T23:59:59.999Z for question_date '2023/05/28 (Sun) 06:47'", () => {
    const q = {
      question_id: "ei-001",
      question_type: "temporal-reasoning",
      question: "test",
      question_date: "2023/05/28 (Sun) 06:47",
      answer: undefined,
      sessions: [],
      answer_session_ids: [],
    };
    const result = evaluationInstant(q);
    expect(result).toBe(new Date("2023-05-28T23:59:59.999Z").getTime());
  });

  it("arm A INCLUDES a claim whose valid.from is the same day at 21:04 (calibration fix)", () => {
    const { session, close } = openTmpSession();
    const corpusId = "lme-same-day-test";
    session.createCorpus({ id: corpusId, contradictionPolicy: { kind: "always_accept" } });

    // Question at 06:47 on 2023-05-28
    const q = {
      question_id: "same-day-001",
      question_type: "temporal-reasoning",
      question: "Where does the user work?",
      question_date: "2023/05/28 (Sun) 06:47",
      answer: undefined,
      sessions: [],
      answer_session_ids: [],
    };

    // Evidence session from same day at 21:04 (later than the question timestamp but same day)
    const sameDayEveningMs = new Date("2023-05-28T21:04:00Z").getTime();
    session.write(corpusId, {
      subject: "employer",
      key: "employer",
      value: "SameDayCorp",
      valid: { from: sameDayEveningMs, to: Infinity },
      tags: ["session:sess-same-day", "turn:0"],
      confidence: 0.9,
    });

    const a = answerArmA(session, corpusId, q, { k: 10 });
    // Arm A must INCLUDE SameDayCorp (same-day later session is known)
    expect(a.claims.map((c) => c.value)).toContain("SameDayCorp");

    close();
  });

  it("arm A still EXCLUDES a claim from weeks later (genuinely future)", () => {
    const { session, close } = openTmpSession();
    const corpusId = "lme-future-test";
    session.createCorpus({ id: corpusId, contradictionPolicy: { kind: "always_accept" } });

    const q = {
      question_id: "future-001",
      question_type: "temporal-reasoning",
      question: "Where does the user work?",
      question_date: "2023/05/28 (Sun) 06:47",
      answer: undefined,
      sessions: [],
      answer_session_ids: [],
    };

    // Claim from a full day later (2023-05-29) — genuinely future, must be excluded
    const nextDayMs = new Date("2023-05-29T10:00:00Z").getTime();
    session.write(corpusId, {
      subject: "employer",
      key: "employer",
      value: "FutureCorp",
      valid: { from: nextDayMs, to: Infinity },
      tags: ["session:sess-future", "turn:0"],
      confidence: 0.9,
    });

    const a = answerArmA(session, corpusId, q, { k: 10 });
    // Arm A must NOT include FutureCorp (next day is genuinely future)
    expect(a.claims.map((c) => c.value)).not.toContain("FutureCorp");

    close();
  });
});

// ---------------------------------------------------------------------------
// Double-quote in question flows through without error
// ---------------------------------------------------------------------------

it("a question with a double quote flows through both arms without error", () => {
  const { session, close, corpusId } = seedSupersedingPair();
  const q = {
    question_id: "dq-001",
    question_type: "knowledge-update",
    question: 'What is the user\'s "current" employer?',
    question_date: "2023/12/01 (Fri) 10:00",
    answer: "Globex",
    sessions: [],
    answer_session_ids: [],
  };

  expect(() => {
    answerArmA(session, corpusId, q, { k: 5 });
    answerArmB(session, corpusId, q, { k: 5 });
  }).not.toThrow();

  close();
});

// ---------------------------------------------------------------------------
// Provenance tags intact
// ---------------------------------------------------------------------------

it("returned claims have provenance tags intact", () => {
  const { session, close, corpusId, q } = seedSupersedingPair();

  const a = answerArmA(session, corpusId, q, { k: 5 });
  const b = answerArmB(session, corpusId, q, { k: 5 });

  // arm A: only Globex survives, must have session:sess-ku-2
  expect(a.claims.every((c) => c.tags.length > 0)).toBe(true);
  const aTags = a.claims.flatMap((c) => c.tags);
  expect(aTags.some((t) => t.startsWith("session:"))).toBe(true);

  // arm B: both claims must have tags
  expect(b.claims.every((c) => c.tags.length > 0)).toBe(true);
  const bTags = b.claims.flatMap((c) => c.tags);
  expect(bTags.some((t) => t.startsWith("session:"))).toBe(true);

  close();
});

// ---------------------------------------------------------------------------
// arm B always returns abstained: false
// ---------------------------------------------------------------------------

it("arm B always returns abstained: false regardless of content", () => {
  const { session, close, corpusId, q } = seedSupersedingPair();
  const b = answerArmB(session, corpusId, q, { k: 5 });
  expect(b.abstained).toBe(false);
  close();
});
