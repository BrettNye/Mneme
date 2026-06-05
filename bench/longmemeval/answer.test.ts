import { describe, it, expect } from "vitest";
import { answerArmA, answerArmB, questionInstant, resolveDeprecateOlder } from "./answer.js";
import { seedSupersedingPair, openTmpSession, claimTagged } from "./test-support.js";
import type { Claim } from "../../src/core/claim.js";
import { corpusOf } from "../../src/algebra/types.js";
import { pairsOf } from "../../src/algebra/contradiction.js";

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
// resolveDeprecateOlder unit tests
// ---------------------------------------------------------------------------

describe("resolveDeprecateOlder", () => {
  it("deprecates the claim with earlier valid.from", () => {
    const earlier = claimTagged("sess-1", "0", {
      id: "claim-aaa" as any,
      value: "Initech",
      valueHash: "hash-initech",
      valid: { from: new Date("2023-01-01T00:00:00Z").getTime(), to: Infinity },
    });
    const later = claimTagged("sess-2", "0", {
      id: "claim-bbb" as any,
      value: "Globex",
      valueHash: "hash-globex",
      valid: { from: new Date("2023-06-01T00:00:00Z").getTime(), to: Infinity },
    });
    const corpus = corpusOf([earlier, later]);
    const pairs = pairsOf(corpus, 0.5);
    const resolved = resolveDeprecateOlder(pairs)(corpus);

    const statuses = new Map(resolved.claims.map((c) => [c.value, c.status]));
    expect(statuses.get("Initech")).toBe("deprecated");
    expect(statuses.get("Globex")).toBe("validated");
  });

  it("breaks valid.from ties by deprecating the lexicographically-higher id", () => {
    const sameTime = new Date("2023-06-01T00:00:00Z").getTime();
    const claimAlpha = claimTagged("sess-1", "0", {
      id: "claim-aaa" as any,
      value: "Alpha",
      valueHash: "hash-alpha",
      valid: { from: sameTime, to: Infinity },
    });
    const claimBeta = claimTagged("sess-2", "0", {
      id: "claim-zzz" as any,
      value: "Beta",
      valueHash: "hash-beta",
      valid: { from: sameTime, to: Infinity },
    });
    const corpus = corpusOf([claimAlpha, claimBeta]);
    const pairs = pairsOf(corpus, 0.5);
    const resolved = resolveDeprecateOlder(pairs)(corpus);

    // "claim-zzz" > "claim-aaa" lexicographically → "claim-zzz" (Beta) should be deprecated
    const statuses = new Map(resolved.claims.map((c) => [c.value, c.status]));
    expect(statuses.get("Beta")).toBe("deprecated");
    expect(statuses.get("Alpha")).toBe("validated");
  });
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
