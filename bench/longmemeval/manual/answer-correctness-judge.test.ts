import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Claim } from "../../../src/core/claim.js";
import {
  renderContextClaim, buildAnswerJudgePrompt, parseAnswerVerdict,
  judgeCacheKey, loadJudgeCache, appendJudgeHeaderIfNew, appendJudgeRecord,
  ANSWER_JUDGE_MODEL, ANSWER_JUDGE_PROMPT_VERSION, CONTEXT_K,
  type JudgeRecord,
} from "./answer-correctness-judge.js";

function claim(subject: string, key: string, value: unknown, validFrom: number): Claim {
  return { subject, key, value, valid: { from: validFrom, to: Infinity } } as unknown as Claim;
}

describe("renderContextClaim", () => {
  it("renders subject.key = value (as of ISO), value canonicalized", () => {
    const s = renderContextClaim(claim("alice", "employer", "Globex", Date.UTC(2023, 5, 1)));
    expect(s).toContain("alice.employer = ");
    expect(s).toContain("Globex");
    expect(s).toContain("2023-06-01");
    expect(s).toMatch(/as of/);
  });
});

describe("buildAnswerJudgePrompt", () => {
  it("includes the question, the gold answer, and every context line", () => {
    const p = buildAnswerJudgePrompt({
      question: "Where does alice work now?",
      gold: "Globex",
      context: ["alice.employer = Globex (as of 2023-06-01T00:00:00.000Z)"],
    });
    expect(p).toContain("Where does alice work now?");
    expect(p).toContain("Globex");
    expect(p).toContain("alice.employer = Globex");
    expect(p).toMatch(/JSON/);
  });
});

describe("parseAnswerVerdict", () => {
  it("parses a valid verdict", () => {
    expect(parseAnswerVerdict('{"correct": true, "reason": "x"}')).toEqual({ correct: true, reason: "x" });
  });
  it("returns null on non-boolean correct or unparseable text", () => {
    expect(parseAnswerVerdict('{"correct": "yes"}')).toBeNull();
    expect(parseAnswerVerdict("not json")).toBeNull();
  });
});

describe("cache", () => {
  function tmp(): string { return join(mkdtempSync(join(tmpdir(), "ans-judge-")), "j.jsonl"); }
  const header = { model: ANSWER_JUDGE_MODEL, promptVersion: ANSWER_JUDGE_PROMPT_VERSION, contextK: CONTEXT_K };

  it("round-trips records keyed by cell|questionId", () => {
    const path = tmp();
    appendJudgeHeaderIfNew(path, header);
    const rec: JudgeRecord = { cell: "a0.5", questionId: "q1", category: "knowledge-update", correct: true, reason: "ok" };
    appendJudgeRecord(path, rec);
    const cache = loadJudgeCache(path, header);
    expect(cache.get(judgeCacheKey("a0.5", "q1"))).toEqual(rec);
  });

  it("aborts on header mismatch", () => {
    const path = tmp();
    writeFileSync(path, JSON.stringify({ kind: "answer-judge-header", model: "other", promptVersion: "x", contextK: 5 }) + "\n", "utf8");
    expect(() => loadJudgeCache(path, header)).toThrow(/header/i);
  });

  it("recovers a torn final line (drops it, keeps valid records)", () => {
    const path = tmp();
    appendJudgeHeaderIfNew(path, header);
    appendJudgeRecord(path, { cell: "a1", questionId: "q1", category: "knowledge-update", correct: false, reason: "r" });
    writeFileSync(path, readFileSync(path, "utf8") + '{"cell":"a1","questionId":"q2","corr', "utf8"); // torn
    const cache = loadJudgeCache(path, header);
    expect(cache.size).toBe(1);
    expect(cache.has(judgeCacheKey("a1", "q1"))).toBe(true);
  });
});
