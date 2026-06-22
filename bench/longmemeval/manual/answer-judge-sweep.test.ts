import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./answer-judge-sweep.js";
import type { JudgeFn } from "./answer-correctness-judge.js";

// Deterministic stub judge — no network. "correct" iff the gold appears in any
// context line. (This is only a wiring stub; the real run uses the LLM judge.)
const stubJudge: JudgeFn = async (item) => ({
  correct: item.context.some((c) => c.includes(item.gold)),
  reason: "stub",
});

describe("answer-judge-sweep CLI", () => {
  it("errors without --file/--claims", async () => {
    const errs: string[] = [];
    const code = await main([], { onError: (m) => errs.push(m), judge: stubJudge });
    expect(code).toBe(1);
    expect(errs.join(" ")).toMatch(/--file and --claims are required/);
  });

  it("runs the fixture end-to-end with a stub judge: columns + verdict render", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "ajs-")), "judgments.jsonl");
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      const code = await main(
        // NO --raw: the fixture is already normalized (Zod) form; --raw would route
        // through normalizeQuestion (raw-HF fields) and crash. --raw is for the oracle only.
        ["--file", "bench/longmemeval/fixtures/dataset.json",
         "--claims", "bench/longmemeval/fixtures/claims.jsonl",
         "--alphas", "1.0,0.0", "--out", out],
        { judge: stubJudge },
      );
      expect(code).toBe(0);
    } finally { console.log = orig; }
    const text = logs.join("\n");
    expect(text).toMatch(/answerInContext/);
    expect(text).toMatch(/CONFIRMED|REFUTED-KU|REFUTED-TR/);
  });

  it("resumes from cache without re-judging (second run reports 0 new)", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "ajs-")), "judgments.jsonl");
    const args = ["--file", "bench/longmemeval/fixtures/dataset.json",
      "--claims", "bench/longmemeval/fixtures/claims.jsonl",
      "--alphas", "1.0", "--out", out]; // no --raw: fixture is normalized (see above)
    await main(args, { judge: stubJudge });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try { await main(args, { judge: stubJudge }); } finally { console.log = orig; }
    expect(logs.join("\n")).toMatch(/0 new|cached/i);
  });
});
