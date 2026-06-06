import { describe, it, expect, beforeEach } from "vitest";
import { answerArmA, answerArmB, questionInstant, evaluationInstant } from "./answer.js";
import { seedSupersedingPair, openTmpSession } from "./test-support.js";
import type { Claim } from "../../src/core/claim.js";
import { CONTRADICTION_FLAG_KEY } from "../../src/algebra/resolution.js";
import { registerSimilarity } from "../../src/algebra/similarity.js";

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

// ---------------------------------------------------------------------------
// Probe-1: keyCardinality multi keeps both hobby claims
// ---------------------------------------------------------------------------

it("keeps both values of a key declared multi (probe-1 shape)", () => {
  const { session, close } = openTmpSession();
  const corpusId = "lme-hobby-multi-test";
  session.createCorpus({ id: corpusId, contradictionPolicy: { kind: "always_accept" } });

  // painting day 0
  const day0 = new Date("2023-01-01T10:00:00Z").getTime();
  session.write(corpusId, {
    subject: "user",
    key: "hobby",
    value: "painting landscapes",
    valid: { from: day0, to: Infinity },
    tags: ["session:sess-hobby-1", "turn:0"],
    confidence: 0.9,
  });

  // running day 30
  const day30 = new Date("2023-01-31T10:00:00Z").getTime();
  session.write(corpusId, {
    subject: "user",
    key: "hobby",
    value: "running marathons",
    valid: { from: day30, to: Infinity },
    tags: ["session:sess-hobby-2", "turn:0"],
    confidence: 0.9,
  });

  const q = {
    question_id: "hobby-multi-001",
    question_type: "knowledge-update",
    question: "What are the user's hobbies?",
    question_date: "2023/12/01 (Fri) 10:00",
    answer: undefined,
    sessions: [],
    answer_session_ids: [],
  };

  const a = answerArmA(session, corpusId, q, { k: 5, keyCardinality: { hobby: "multi" } });
  expect(a.claims.map((c) => c.value)).toEqual(
    expect.arrayContaining(["painting landscapes", "running marathons"])
  );
  close();
});

it("without keyCardinality multi, older hobby is deprecated (single-cardinality default)", () => {
  const { session, close } = openTmpSession();
  const corpusId = "lme-hobby-single-test";
  session.createCorpus({ id: corpusId, contradictionPolicy: { kind: "always_accept" } });

  const day0 = new Date("2023-01-01T10:00:00Z").getTime();
  session.write(corpusId, {
    subject: "user",
    key: "hobby",
    value: "painting landscapes",
    valid: { from: day0, to: Infinity },
    tags: ["session:sess-hobby-1", "turn:0"],
    confidence: 0.9,
  });

  const day30 = new Date("2023-01-31T10:00:00Z").getTime();
  session.write(corpusId, {
    subject: "user",
    key: "hobby",
    value: "running marathons",
    valid: { from: day30, to: Infinity },
    tags: ["session:sess-hobby-2", "turn:0"],
    confidence: 0.9,
  });

  const q = {
    question_id: "hobby-single-001",
    question_type: "knowledge-update",
    question: "What is the user's hobby?",
    question_date: "2023/12/01 (Fri) 10:00",
    answer: undefined,
    sessions: [],
    answer_session_ids: [],
  };

  // No keyCardinality map → single-cardinality default → older deprecated
  const a = answerArmA(session, corpusId, q, { k: 5 });
  expect(a.claims.map((c) => c.value)).not.toContain("painting landscapes");
  expect(a.claims.map((c) => c.value)).toContain("running marathons");
  close();
});

// ---------------------------------------------------------------------------
// Probe-6: floor 0 semantics — fresh low-confidence contests stale high-confidence
// ---------------------------------------------------------------------------

it("probe-6: fresh p=0.4 claim contests stale p=1.0 at default floor 0", () => {
  const { session, close } = openTmpSession();
  const corpusId = "lme-probe6-test";
  session.createCorpus({ id: corpusId, contradictionPolicy: { kind: "always_accept" } });

  // Stale high-confidence claim
  const staleMs = new Date("2023-01-01T10:00:00Z").getTime();
  session.write(corpusId, {
    subject: "user",
    key: "city",
    value: "old city",
    valid: { from: staleMs, to: Infinity },
    tags: ["session:sess-stale", "turn:0"],
    confidence: 1.0,
  });

  // Fresh low-confidence claim
  const freshMs = new Date("2023-06-01T10:00:00Z").getTime();
  session.write(corpusId, {
    subject: "user",
    key: "city",
    value: "new city",
    valid: { from: freshMs, to: Infinity },
    tags: ["session:sess-fresh", "turn:0"],
    confidence: 0.4,
  });

  const q = {
    question_id: "probe6-001",
    question_type: "knowledge-update",
    question: "What city does the user live in?",
    question_date: "2023/12/01 (Fri) 10:00",
    answer: undefined,
    sessions: [],
    answer_session_ids: [],
  };

  // Default floor 0: fresh p=0.4 claim eligible → resolveDeprecateOlder picks fresh (later valid.from)
  const a = answerArmA(session, corpusId, q, { k: 5 });
  expect(a.claims.map((c) => c.value)).toContain("new city");
  expect(a.claims.map((c) => c.value)).not.toContain("old city");
  close();
});

it("probe-6: conflictThreshold 0.5 hides fresh p=0.4 challenger (old hidden-challenger behavior)", () => {
  const { session, close } = openTmpSession();
  const corpusId = "lme-probe6-threshold-test";
  session.createCorpus({ id: corpusId, contradictionPolicy: { kind: "always_accept" } });

  const staleMs = new Date("2023-01-01T10:00:00Z").getTime();
  session.write(corpusId, {
    subject: "user",
    key: "city",
    value: "old city",
    valid: { from: staleMs, to: Infinity },
    tags: ["session:sess-stale", "turn:0"],
    confidence: 1.0,
  });

  const freshMs = new Date("2023-06-01T10:00:00Z").getTime();
  session.write(corpusId, {
    subject: "user",
    key: "city",
    value: "new city",
    valid: { from: freshMs, to: Infinity },
    tags: ["session:sess-fresh", "turn:0"],
    confidence: 0.4,
  });

  const q = {
    question_id: "probe6-threshold-001",
    question_type: "knowledge-update",
    question: "What city does the user live in?",
    question_date: "2023/12/01 (Fri) 10:00",
    answer: undefined,
    sessions: [],
    answer_session_ids: [],
  };

  // conflictThreshold 0.5: fresh p=0.4 is <= 0.5 so not eligible → no contest → both survive
  const a = answerArmA(session, corpusId, q, { k: 5, conflictThreshold: 0.5 });
  expect(a.claims.map((c) => c.value)).toContain("old city");
  expect(a.claims.map((c) => c.value)).toContain("new city");
  close();
});

// ---------------------------------------------------------------------------
// Dedupe: token-overlap paraphrase merged before ⊥ detection
// ---------------------------------------------------------------------------

it("token-overlap paraphrase (jaccard >= 0.5) merges before detection — one claim, no flag artifact", () => {
  const { session, close } = openTmpSession();
  const corpusId = "lme-dedupe-overlap-test";
  session.createCorpus({ id: corpusId, contradictionPolicy: { kind: "always_accept" } });

  const day0 = new Date("2023-01-01T10:00:00Z").getTime();
  session.write(corpusId, {
    subject: "user",
    key: "job_title",
    value: "senior software engineer",
    valid: { from: day0, to: Infinity },
    tags: ["session:sess-title-1", "turn:0"],
    confidence: 0.8,
  });

  const day10 = new Date("2023-01-11T10:00:00Z").getTime();
  session.write(corpusId, {
    subject: "user",
    key: "job_title",
    value: "senior software engineer at Globex",
    valid: { from: day10, to: Infinity },
    tags: ["session:sess-title-2", "turn:0"],
    confidence: 0.9,
  });

  const q = {
    question_id: "dedupe-overlap-001",
    question_type: "knowledge-update",
    question: "What is the user's job title?",
    question_date: "2023/12/01 (Fri) 10:00",
    answer: undefined,
    sessions: [],
    answer_session_ids: [],
  };

  const a = answerArmA(session, corpusId, q, { k: 5 });
  // Only one claim for the triple (merged)
  const jobTitleClaims = a.claims.filter((c) => c.key === "job_title");
  expect(jobTitleClaims).toHaveLength(1);
  // Value is the latest member's value
  expect(jobTitleClaims[0].value).toBe("senior software engineer at Globex");
  // No contradiction flag artifact
  expect(a.claims.some((c) => c.key === CONTRADICTION_FLAG_KEY)).toBe(false);
  close();
});

// ---------------------------------------------------------------------------
// Dedupe: acronym paraphrase NOT merged (jaccard 0) — older deprecated by recency
// ---------------------------------------------------------------------------

it("acronym paraphrase (NYC vs New York City) NOT merged — older deprecated by recency", () => {
  const { session, close } = openTmpSession();
  const corpusId = "lme-dedupe-acronym-test";
  session.createCorpus({ id: corpusId, contradictionPolicy: { kind: "always_accept" } });

  const day0 = new Date("2023-01-01T10:00:00Z").getTime();
  session.write(corpusId, {
    subject: "user",
    key: "city",
    value: "NYC",
    valid: { from: day0, to: Infinity },
    tags: ["session:sess-city-1", "turn:0"],
    confidence: 0.9,
  });

  const day30 = new Date("2023-01-31T10:00:00Z").getTime();
  session.write(corpusId, {
    subject: "user",
    key: "city",
    value: "New York City",
    valid: { from: day30, to: Infinity },
    tags: ["session:sess-city-2", "turn:0"],
    confidence: 0.9,
  });

  const q = {
    question_id: "dedupe-acronym-001",
    question_type: "knowledge-update",
    question: "What city does the user live in?",
    question_date: "2023/12/01 (Fri) 10:00",
    answer: undefined,
    sessions: [],
    answer_session_ids: [],
  };

  const a = answerArmA(session, corpusId, q, { k: 5 });
  // NYC and "New York City" have jaccard 0 (no shared tokens) — NOT merged
  // resolveDeprecateOlder picks later valid.from → "New York City" survives
  expect(a.claims.map((c) => c.value)).toContain("New York City");
  expect(a.claims.map((c) => c.value)).not.toContain("NYC");
  close();
});

// ---------------------------------------------------------------------------
// rankFn + relevanceFloor: arm A abstains when no claim clears the floor
// ---------------------------------------------------------------------------

// Shared fake fn objects — registered once per describe block via module-level const
// so same-object re-registration (no-op) works when tests run in the same module.
const fakeLowFn = { isPure: true as const, version: "fake-low@1", scoreOne: () => 0.1 };
const fakeRankOrderFn = {
  isPure: true as const,
  version: "fake-rank-order@1",
  scoreOne: (v: unknown) => (String(v) === "target value" ? 0.9 : 0.1),
};

describe("rankFn + relevanceFloor", () => {
  // Register fakes before the describe block runs; same-object re-register is a no-op.
  beforeEach(() => {
    registerSimilarity("fake-low", fakeLowFn);
    registerSimilarity("fake-rank-order", fakeRankOrderFn);
  });

  // Use unique corpus IDs per test to avoid cross-test contamination.
  it("arm A abstains when no claim clears the relevance floor", () => {
    const { session, close } = openTmpSession();
    const corpusId = "lme-floor-abstain-test";
    session.createCorpus({ id: corpusId, contradictionPolicy: { kind: "always_accept" } });

    session.write(corpusId, {
      subject: "user",
      key: "city",
      value: "Somecity",
      valid: { from: new Date("2023-01-01T10:00:00Z").getTime(), to: Infinity },
      tags: ["session:sess-floor-1", "turn:0"],
      confidence: 0.9,
    });

    const q = {
      question_id: "floor-abstain-001",
      question_type: "knowledge-update",
      question: "Where does the user live?",
      question_date: "2023/12/01 (Fri) 10:00",
      answer: undefined,
      sessions: [],
      answer_session_ids: [],
    };

    const a = answerArmA(session, corpusId, q, { k: 5, rankFn: "fake-low", relevanceFloor: 0.5 });
    expect(a.abstained).toBe(true);
    expect(a.claims).toHaveLength(0);
    close();
  });

  it("relevanceFloor 0 never abstains on a non-empty ranked corpus", () => {
    const { session, close } = openTmpSession();
    const corpusId = "lme-floor-zero-test";
    session.createCorpus({ id: corpusId, contradictionPolicy: { kind: "always_accept" } });

    session.write(corpusId, {
      subject: "user",
      key: "city",
      value: "Anycity",
      valid: { from: new Date("2023-01-01T10:00:00Z").getTime(), to: Infinity },
      tags: ["session:sess-floor-zero-1", "turn:0"],
      confidence: 0.9,
    });

    const q = {
      question_id: "floor-zero-001",
      question_type: "knowledge-update",
      question: "Where does the user live?",
      question_date: "2023/12/01 (Fri) 10:00",
      answer: undefined,
      sessions: [],
      answer_session_ids: [],
    };

    // relevanceFloor 0 means filter is >= 0, which all scores pass
    const a = answerArmA(session, corpusId, q, { k: 5, rankFn: "fake-low", relevanceFloor: 0 });
    expect(a.abstained).toBe(false);
    expect(a.claims.length).toBeGreaterThan(0);
    close();
  });

  it("rankFn with a registered fake semantic fn changes ranking order (deterministic)", () => {
    const { session, close } = openTmpSession();
    const corpusId = "lme-rank-order-test";
    session.createCorpus({ id: corpusId, contradictionPolicy: { kind: "always_accept" } });

    // "the user preference" shares tokens with both values below;
    // jaccard would rank "preferred answer" highest (shares "prefer*" and "answer" tokens with question).
    // fake-rank-order gives "target value" 0.9 and "preferred answer" 0.1 — inverts the jaccard order.
    session.write(corpusId, {
      subject: "user",
      key: "pref",
      value: "preferred answer",
      valid: { from: new Date("2023-01-01T10:00:00Z").getTime(), to: Infinity },
      tags: ["session:sess-rank-1", "turn:0"],
      confidence: 0.9,
    });
    session.write(corpusId, {
      subject: "user",
      key: "pref",
      value: "target value",
      valid: { from: new Date("2023-02-01T10:00:00Z").getTime(), to: Infinity },
      tags: ["session:sess-rank-2", "turn:0"],
      confidence: 0.9,
    });

    const q = {
      question_id: "rank-order-001",
      question_type: "knowledge-update",
      question: "What is the user's preferred answer?",
      question_date: "2023/12/01 (Fri) 10:00",
      answer: undefined,
      sessions: [],
      answer_session_ids: [],
    };

    // With jaccard, "preferred answer" would rank first (matches more tokens of the question).
    // With fake-rank-order, "target value" scores 0.9 and "preferred answer" scores 0.1.
    // So fake-rank-order must invert the default jaccard order => "target value" ranks first.
    const a = answerArmA(session, corpusId, q, { k: 2, rankFn: "fake-rank-order", keyCardinality: { pref: "multi" } });
    expect(a.claims[0].value).toBe("target value");
    close();
  });
});

// ---------------------------------------------------------------------------
// Default rankFn: unspecified => "jaccard", stays synchronous, no registry probe
// ---------------------------------------------------------------------------

it("arm A with no rankFn specified is synchronous and produces same result as explicit jaccard", () => {
  const { session, close, corpusId, q } = seedSupersedingPair();
  const a1 = answerArmA(session, corpusId, q, { k: 5 });
  const a2 = answerArmA(session, corpusId, q, { k: 5, rankFn: "jaccard" });
  expect(a1.claims.map((c) => c.value)).toEqual(a2.claims.map((c) => c.value));
  // Must return a plain object (not a Promise)
  expect(typeof (a1 as unknown as Promise<unknown>).then).toBe("undefined");
  close();
});
