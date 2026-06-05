import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { LmeQuestion, ClaimRecord, CacheHeader } from "../types.js";

const datasetUrl = new URL("./dataset.json", import.meta.url);
const claimsUrl = new URL("./claims.jsonl", import.meta.url);

const qs: unknown[] = JSON.parse(readFileSync(datasetUrl, "utf8"));
const claimsLines = readFileSync(claimsUrl, "utf8").trim().split("\n");
const headerLine = claimsLines[0];
const claimLines = claimsLines.slice(1);

it("dataset.json contains exactly 3 questions", () => {
  expect(qs).toHaveLength(3);
});

it("every fixture question parses under the normalized schema", () => {
  for (const q of qs) {
    const result = LmeQuestion.safeParse(q);
    expect(result.success).toBe(true);
  }
});

it("one question per category (knowledge-update, temporal-reasoning, abstention)", () => {
  const parsed = qs.map((q) => LmeQuestion.parse(q));
  const types = parsed.map((q) => q.question_type);
  expect(types).toContain("knowledge-update");
  expect(types).toContain("temporal-reasoning");
  // abstention is identified by _abs suffix
  const absQuestion = parsed.find((q) => q.question_id.endsWith("_abs"));
  expect(absQuestion).toBeDefined();
});

describe("claims.jsonl", () => {
  it("line 1 parses under CacheHeader", () => {
    const result = CacheHeader.safeParse(JSON.parse(headerLine));
    expect(result.success).toBe(true);
  });

  it("every subsequent line parses under ClaimRecord", () => {
    for (const line of claimLines) {
      const result = ClaimRecord.safeParse(JSON.parse(line));
      expect(result.success).toBe(true);
    }
  });
});

describe("knowledge-update fixture (fx-ku-1)", () => {
  it("has exactly two claims for the same subject+key (superseding pair)", () => {
    const kuClaims = claimLines
      .map((l) => ClaimRecord.parse(JSON.parse(l)))
      .filter((c) => c.tags.some((t) => t.startsWith("session:fx-s1") || t.startsWith("session:fx-s2")));

    expect(kuClaims).toHaveLength(2);

    const [c1, c2] = kuClaims;
    expect(c1.subject).toBe(c2.subject);
    expect(c1.key).toBe(c2.key);
    expect(c1.value).not.toBe(c2.value);
    expect(c1.validFrom).not.toBe(c2.validFrom);
  });
});

describe("temporal-reasoning fixture (fx-tr-1)", () => {
  it("includes at least one claim whose validFrom is after the question's question_date", () => {
    const parsed = qs.map((q) => LmeQuestion.parse(q));
    const trQuestion = parsed.find((q) => q.question_type === "temporal-reasoning");
    expect(trQuestion).toBeDefined();

    const questionDateMs = Date.parse(trQuestion!.question_date);

    const trSessionIds = new Set(trQuestion!.sessions.map((s) => s.sessionId));
    const trClaims = claimLines
      .map((l) => ClaimRecord.parse(JSON.parse(l)))
      .filter((c) => c.tags.some((t) => {
        const sessionId = t.replace("session:", "");
        return t.startsWith("session:") && trSessionIds.has(sessionId);
      }));

    const hasPostQuestionClaim = trClaims.some((c) => c.validFrom > questionDateMs);
    expect(hasPostQuestionClaim).toBe(true);
  });
});

describe("abstention fixture (fx-abs-1_abs)", () => {
  it("answer_session_ids is empty", () => {
    const parsed = qs.map((q) => LmeQuestion.parse(q));
    const absQuestion = parsed.find((q) => q.question_id.endsWith("_abs"));
    expect(absQuestion).toBeDefined();
    expect(absQuestion!.answer_session_ids).toHaveLength(0);
  });

  it("no claim in claims.jsonl carries its session tags", () => {
    const parsed = qs.map((q) => LmeQuestion.parse(q));
    const absQuestion = parsed.find((q) => q.question_id.endsWith("_abs"));
    expect(absQuestion).toBeDefined();

    const absSessionIds = new Set(absQuestion!.sessions.map((s) => s.sessionId));
    const allClaims = claimLines.map((l) => ClaimRecord.parse(JSON.parse(l)));

    for (const claim of allClaims) {
      const hasAbsTag = claim.tags.some((t) => {
        if (!t.startsWith("session:")) return false;
        const sessionId = t.replace("session:", "");
        return absSessionIds.has(sessionId);
      });
      expect(hasAbsTag).toBe(false);
    }
  });
});
