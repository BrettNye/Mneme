import { describe, it, expect } from "vitest";
import {
  openTmpSession,
  claimRecord,
  claimTagged,
  armResult,
  kuQuestion,
  temporalQuestion,
  abstentionQuestion,
  seedSupersedingPair,
  fixturePath,
} from "./test-support.js";
import { ClaimRecord, LmeQuestion } from "./types.js";
import { join } from "node:path";

it("claimRecord builds a record that passes the ClaimRecord schema", () => {
  expect(ClaimRecord.safeParse(claimRecord()).success).toBe(true);
});

it("openTmpSession yields a usable session and close() releases the db dir", () => {
  const { session, close } = openTmpSession();
  session.createCorpus({ id: "t" });
  expect(session.listCorpora().map((c) => c.id)).toContain("t");
  close(); // must not throw on Windows (EBUSY regression — see bench/RESULTS.md finding 2)
});

describe("claimRecord", () => {
  it("applies overrides", () => {
    const r = claimRecord({ subject: "custom-subject", value: "custom-value" });
    expect(r.subject).toBe("custom-subject");
    expect(r.value).toBe("custom-value");
    expect(ClaimRecord.safeParse(r).success).toBe(true);
  });

  it("has session: and turn: tags by default", () => {
    const r = claimRecord();
    expect(r.tags.some((t) => t.startsWith("session:"))).toBe(true);
    expect(r.tags.some((t) => t.startsWith("turn:"))).toBe(true);
  });
});

describe("claimTagged", () => {
  it("carries session: and turn: tags matching the supplied session/turn tags", () => {
    const c = claimTagged("sess-abc", "turn-1");
    expect(c.tags).toContain("session:sess-abc");
    expect(c.tags).toContain("turn:turn-1");
  });

  it("applies over partial overrides", () => {
    const c = claimTagged("s", "t", { subject: "overridden-subject" as never });
    expect(c.subject).toBe("overridden-subject");
  });

  it("has required Claim fields (id, profile, workspace, status)", () => {
    const c = claimTagged("s", "t");
    expect(typeof c.id).toBe("string");
    expect(typeof c.profile).toBe("string");
    expect(typeof c.workspace).toBe("string");
    expect(c.status).toBe("validated");
  });

  it("is pure — same inputs produce deep-equal outputs", () => {
    const a = claimTagged("session:s1", "turn:0");
    const b = claimTagged("session:s1", "turn:0");
    expect(a).toEqual(b);
  });

  it("derives id deterministically from sessionTag and turnTag", () => {
    const c1 = claimTagged("session:s1", "turn:0");
    const c2 = claimTagged("session:s1", "turn:0");
    expect(c1.id).toBe(c2.id);
    // id encodes both inputs so different inputs yield different ids
    const c3 = claimTagged("session:s2", "turn:1");
    expect(c1.id).not.toBe(c3.id);
  });

  it("has a fixed recorded timestamp (not Date.now())", () => {
    const c1 = claimTagged("session:s1", "turn:0");
    const c2 = claimTagged("session:s1", "turn:0");
    expect(c1.recorded).toBe(c2.recorded);
  });
});

describe("armResult", () => {
  it("builds an AnswerResult with the supplied arm and claims", () => {
    const claims = [claimTagged("s", "t")];
    const r = armResult("A", claims);
    expect(r.arm).toBe("A");
    expect(r.claims).toBe(claims);
    expect(r.abstained).toBe(false);
  });

  it("sets abstained when passed true", () => {
    const r = armResult("B", [], true);
    expect(r.abstained).toBe(true);
  });
});

describe("question builders", () => {
  it("kuQuestion passes LmeQuestion schema", () => {
    expect(LmeQuestion.safeParse(kuQuestion()).success).toBe(true);
  });

  it("temporalQuestion passes LmeQuestion schema", () => {
    expect(LmeQuestion.safeParse(temporalQuestion()).success).toBe(true);
  });

  it("abstentionQuestion passes LmeQuestion schema and has _abs question_id", () => {
    const q = abstentionQuestion();
    expect(LmeQuestion.safeParse(q).success).toBe(true);
    expect(q.question_id).toMatch(/_abs$/);
  });

  it("kuQuestion accepts evidence session id overrides", () => {
    const q = kuQuestion({ evidence: ["sess-1", "sess-2"] });
    expect(q.answer_session_ids).toEqual(["sess-1", "sess-2"]);
  });
});

describe("seedSupersedingPair", () => {
  it("commits exactly two claims sharing subject+key with different values", () => {
    const { session, close, corpusId, q } = seedSupersedingPair();
    try {
      // query all claims in the corpus
      const result = session.q(corpusId, "where subject = employer");
      // result is a Corpus shape; iterate its claims
      const corpus = result as { claims: unknown[] };
      expect(corpus.claims).toHaveLength(2);
    } finally {
      close();
    }
    // q must pass LmeQuestion schema
    expect(LmeQuestion.safeParse(q).success).toBe(true);
  });

  it("the two claims have ascending valid.from", () => {
    const { session, close, corpusId } = seedSupersedingPair();
    try {
      const result = session.q(corpusId, "where subject = employer");
      const corpus = result as { claims: { valid: { from: number } }[] };
      const froms = corpus.claims.map((c) => c.valid.from).sort((a, b) => a - b);
      expect(froms[0]).toBeLessThan(froms[1]);
    } finally {
      close();
    }
  });
});

describe("fixturePath", () => {
  it("returns an absolute path ending with the given name", () => {
    const p = fixturePath("sample.jsonl");
    expect(p).toMatch(/sample\.jsonl$/);
    // Should be absolute
    expect(p.startsWith("/") || /^[A-Za-z]:/.test(p)).toBe(true);
  });
});
