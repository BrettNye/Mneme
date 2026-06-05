import { describe, it, expect } from "vitest";
import {
  scoreQuestion,
  aggregate,
  evidenceSessionsHit,
  type QuestionScore,
  type ScoreRow,
} from "./score.js";
import {
  kuQuestion,
  temporalQuestion,
  abstentionQuestion,
  claimTagged,
  armResult,
} from "./test-support.js";

// ---------------------------------------------------------------------------
// evidenceSessionsHit
// ---------------------------------------------------------------------------

describe("evidenceSessionsHit", () => {
  it("returns empty set when no claims provided", () => {
    const q = kuQuestion({ evidence: ["s1"] });
    const r = armResult("A", []);
    const hit = evidenceSessionsHit(r, q);
    expect(hit.size).toBe(0);
  });

  it("returns the session id when claim matches", () => {
    const q = kuQuestion({ evidence: ["s1"] });
    const r = armResult("A", [claimTagged("s1", "0")]);
    const hit = evidenceSessionsHit(r, q);
    expect(hit.has("s1")).toBe(true);
    expect(hit.size).toBe(1);
  });

  it("does not include non-evidence session ids even if tags match", () => {
    const q = kuQuestion({ evidence: ["s1"] });
    // claim tagged with the background session, not an evidence session
    const r = armResult("A", [claimTagged("sess-ku-bkg", "0")]);
    const hit = evidenceSessionsHit(r, q);
    expect(hit.size).toBe(0);
  });

  it("deduplicates multiple claims pointing to same evidence session", () => {
    const q = kuQuestion({ evidence: ["s1"] });
    const r = armResult("A", [claimTagged("s1", "0"), claimTagged("s1", "1")]);
    const hit = evidenceSessionsHit(r, q);
    expect(hit.size).toBe(1);
    expect(hit.has("s1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evidenceRecallAt
// ---------------------------------------------------------------------------

describe("evidenceRecallAt", () => {
  it("is 1.0 at k=1 when single evidence session hit by first claim", () => {
    const q = kuQuestion({ evidence: ["s1"] });
    const r = armResult("A", [claimTagged("s1", "0"), claimTagged("s1", "1")]);
    const score = scoreQuestion(q, r, [1, 3]);
    expect(score.evidenceRecallAt[1]).toBe(1.0);
  });

  it("is 0 at k=1 when first claim misses evidence sessions", () => {
    const q = kuQuestion({ evidence: ["s1"] });
    // claim tagged with a non-evidence session
    const r = armResult("A", [claimTagged("sess-ku-bkg", "0"), claimTagged("s1", "1")]);
    const score = scoreQuestion(q, r, [1, 3]);
    expect(score.evidenceRecallAt[1]).toBe(0);
  });

  it("is 1/2 at k=1 when 2 evidence sessions but only first claim hits one", () => {
    const q = kuQuestion({ evidence: ["s1", "s2"] });
    const r = armResult("A", [claimTagged("s1", "0"), claimTagged("sess-ku-bkg", "1")]);
    const score = scoreQuestion(q, r, [1, 3]);
    expect(score.evidenceRecallAt[1]).toBeCloseTo(0.5);
  });

  it("is 1.0 at k=3 when both evidence sessions covered within top 3", () => {
    const q = kuQuestion({ evidence: ["s1", "s2"] });
    const r = armResult("A", [
      claimTagged("s1", "0"),
      claimTagged("sess-ku-bkg", "0"),
      claimTagged("s2", "0"),
    ]);
    const score = scoreQuestion(q, r, [1, 3]);
    expect(score.evidenceRecallAt[3]).toBe(1.0);
  });

  it("returns empty evidenceRecallAt when answer_session_ids is empty (abstention)", () => {
    const q = abstentionQuestion();
    const r = armResult("A", [], true);
    const score = scoreQuestion(q, r, [1, 3]);
    expect(score.evidenceRecallAt).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// updateCorrect
// ---------------------------------------------------------------------------

describe("updateCorrect", () => {
  it("is undefined for non-KU categories", () => {
    const q = temporalQuestion({ evidence: ["s1"] });
    const r = armResult("A", [claimTagged("s1", "0")]);
    const score = scoreQuestion(q, r, [1]);
    expect(score.updateCorrect).toBeUndefined();
  });

  it("is undefined for abstention category", () => {
    const q = abstentionQuestion();
    const r = armResult("A", [], true);
    const score = scoreQuestion(q, r, [1]);
    expect(score.updateCorrect).toBeUndefined();
  });

  it("is true when the top claim traces to the latest evidence session", () => {
    // s-new is the last in evidence array, used as tiebreaker for same-date sessions
    const q = kuQuestion({ evidence: ["s-old", "s-new"] });
    const r = armResult("A", [claimTagged("s-new", "0")]);
    expect(scoreQuestion(q, r, [1]).updateCorrect).toBe(true);
  });

  it("is false when the top claim traces to the superseded session", () => {
    const q = kuQuestion({ evidence: ["s-old", "s-new"] }); // s-new is latest by date (array order tiebreak)
    const r = armResult("A", [claimTagged("s-old", "0")]);
    expect(scoreQuestion(q, r, [1]).updateCorrect).toBe(false);
  });

  it("is false when claims is empty (KU failed to retrieve)", () => {
    const q = kuQuestion({ evidence: ["s1"] });
    const r = armResult("A", []);
    expect(scoreQuestion(q, r, [1]).updateCorrect).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// temporalCorrect
// ---------------------------------------------------------------------------

describe("temporalCorrect", () => {
  it("is undefined for KU category", () => {
    const q = kuQuestion({ evidence: ["s1"] });
    const r = armResult("A", [claimTagged("s1", "0")]);
    const score = scoreQuestion(q, r, [1]);
    expect(score.temporalCorrect).toBeUndefined();
  });

  it("is undefined for abstention category", () => {
    const q = abstentionQuestion();
    const r = armResult("A", [], true);
    const score = scoreQuestion(q, r, [1]);
    expect(score.temporalCorrect).toBeUndefined();
  });

  it("is true when claim traces to evidence session with date before question_date", () => {
    // temporalQuestion default evidence "sess-tr-1", date "2023/03/15 (Wed) 09:00",
    // question_date "2023/12/01 (Fri) 10:00"
    const q = temporalQuestion({ evidence: ["sess-tr-1"] });
    const r = armResult("A", [claimTagged("sess-tr-1", "0")]);
    expect(scoreQuestion(q, r, [1]).temporalCorrect).toBe(true);
  });

  it("is false when a claim traces to session with date after question_date", () => {
    // Build a question with question_date before the session dates
    const q = temporalQuestion({ evidence: ["sess-tr-1"] });
    // Override question_date to be before session date "2023/03/15"
    const qEarly = { ...q, question_date: "2023/01/01 (Sun) 10:00" };
    // The session date "2023/03/15 (Wed) 09:00" is AFTER "2023/01/01"
    const r = armResult("A", [claimTagged("sess-tr-1", "0")]);
    expect(scoreQuestion(qEarly, r, [1]).temporalCorrect).toBe(false);
  });

  it("is false when no evidence sessions hit (no right-period evidence)", () => {
    // claim traces to background session, not evidence session
    const q = temporalQuestion({ evidence: ["sess-tr-1"] });
    const r = armResult("A", [claimTagged("sess-tr-bkg", "0")]);
    expect(scoreQuestion(q, r, [1]).temporalCorrect).toBe(false);
  });

  it("is false when claims list is empty", () => {
    const q = temporalQuestion({ evidence: ["sess-tr-1"] });
    const r = armResult("A", []);
    expect(scoreQuestion(q, r, [1]).temporalCorrect).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// abstentionCorrect
// ---------------------------------------------------------------------------

describe("abstentionCorrect", () => {
  it("is undefined for KU category", () => {
    const q = kuQuestion({ evidence: ["s1"] });
    const r = armResult("A", [claimTagged("s1", "0")]);
    expect(scoreQuestion(q, r, [1]).abstentionCorrect).toBeUndefined();
  });

  it("is true when abstained on abstention question", () => {
    const q = abstentionQuestion();
    const r = armResult("A", [], true);
    expect(scoreQuestion(q, r, [1]).abstentionCorrect).toBe(true);
  });

  it("is false when not abstained on abstention question", () => {
    const q = abstentionQuestion();
    const r = armResult("A", [claimTagged("sess-abs-1", "0")], false);
    expect(scoreQuestion(q, r, [1]).abstentionCorrect).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

describe("aggregate", () => {
  it("produces rows for each category×arm×metric with correct mean and n", () => {
    // 2 KU questions, 1 temporal, 1 abstention — all arm A
    // KU q1: top claim hits s-new (latest) → updateCorrect=true; hits 1/1 evidence → recall@1=1.0
    // KU q2: top claim hits s-old (not latest) → updateCorrect=false; misses → recall@1=0.0
    const kuQ1 = kuQuestion({ evidence: ["s-old", "s-new"] });
    const kuQ2 = kuQuestion({ evidence: ["s-old", "s-new"] });
    const trQ = temporalQuestion({ evidence: ["sess-tr-1"] });
    const absQ = abstentionQuestion();

    const kuR1 = armResult("A", [claimTagged("s-new", "0")]);
    const kuR2 = armResult("A", [claimTagged("s-old", "0")]);
    const trR = armResult("A", [claimTagged("sess-tr-1", "0")]);
    const absR = armResult("A", [], true);

    const ks = [1, 3];
    const scores = [
      scoreQuestion(kuQ1, kuR1, ks),
      scoreQuestion(kuQ2, kuR2, ks),
      scoreQuestion(trQ, trR, ks),
      scoreQuestion(absQ, absR, ks),
    ];

    const rows = aggregate(scores, ks);

    // Helper to find a row
    function findRow(category: string, arm: string, metric: string): ScoreRow | undefined {
      return rows.find(
        (r) => r.category === category && r.arm === arm && r.metric === metric
      );
    }

    // KU: updateCorrect mean = (1 + 0) / 2 = 0.5
    const kuUpdate = findRow("knowledge-update", "A", "updateCorrect");
    expect(kuUpdate).toBeDefined();
    expect(kuUpdate!.value).toBeCloseTo(0.5);
    expect(kuUpdate!.n).toBe(2);

    // KU: recall@1 — kuQ1 has 2 evidence sessions (s-old, s-new), kuR1 hits s-new → 1/2
    //               kuQ2 has 2 evidence sessions, kuR2 hits s-old → 1/2
    // mean recall@1 = (0.5 + 0.5) / 2 = 0.5
    const kuRecall1 = findRow("knowledge-update", "A", "recall@1");
    expect(kuRecall1).toBeDefined();
    expect(kuRecall1!.value).toBeCloseTo(0.5);
    expect(kuRecall1!.n).toBe(2);

    // temporal: recall@1 — trQ has 1 evidence, trR hits it → recall@1=1.0
    const trRecall1 = findRow("temporal-reasoning", "A", "recall@1");
    expect(trRecall1).toBeDefined();
    expect(trRecall1!.value).toBeCloseTo(1.0);
    expect(trRecall1!.n).toBe(1);

    // temporal: temporalCorrect — trR's session date "2023/03/15" < question_date "2023/12/01"
    //                             AND hits evidence session → true
    const trTemporal = findRow("temporal-reasoning", "A", "temporalCorrect");
    expect(trTemporal).toBeDefined();
    expect(trTemporal!.value).toBeCloseTo(1.0);
    expect(trTemporal!.n).toBe(1);

    // abstention: abstentionCorrect — abstained=true → 1.0
    const absAbstention = findRow("abstention", "A", "abstentionCorrect");
    expect(absAbstention).toBeDefined();
    expect(absAbstention!.value).toBeCloseTo(1.0);
    expect(absAbstention!.n).toBe(1);

    // abstention: evidenceRecallAt should be empty (answer_session_ids=[])
    // so no recall@k rows for abstention
    const absRecall1 = findRow("abstention", "A", "recall@1");
    expect(absRecall1).toBeUndefined();

    // There should be no KU rows for temporalCorrect
    const kuTemporal = findRow("knowledge-update", "A", "temporalCorrect");
    expect(kuTemporal).toBeUndefined();

    // There should be no temporal rows for updateCorrect
    const trUpdate = findRow("temporal-reasoning", "A", "updateCorrect");
    expect(trUpdate).toBeUndefined();
  });
});
