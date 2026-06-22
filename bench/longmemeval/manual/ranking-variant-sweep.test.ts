import { describe, it, expect } from "vitest";
import { main } from "./ranking-variant-sweep.js";

describe("ranking-variant-sweep CLI", () => {
  it("errors without --file/--claims", async () => {
    const errs: string[] = [];
    const code = await main([], { onError: (m) => errs.push(m) });
    expect(code).toBe(1);
    expect(errs.join(" ")).toMatch(/--file and --claims are required/);
  });

  it("rejects an out-of-range alpha", async () => {
    const errs: string[] = [];
    const code = await main(
      ["--file", "x.json", "--claims", "y.jsonl", "--alphas", "1.5"],
      { onError: (m) => errs.push(m) },
    );
    expect(code).toBe(1);
    expect(errs.join(" ")).toMatch(/alphas/);
  });

  it("runs the fixture end-to-end, passes the baseline+identity gate, renders columns", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      const code = await main([
        "--file", "bench/longmemeval/fixtures/dataset.json",
        "--claims", "bench/longmemeval/fixtures/claims.jsonl",
        "--alphas", "1.0,0.0", "--half-lives", "90",
        "--expect-update-correct", "1.0",
      ]);
      expect(code).toBe(0);
    } finally { console.log = orig; }
    const out = logs.join("\n");
    expect(out).toMatch(/identical to arm A/);   // identity gate line
    expect(out).toMatch(/temporalCorrect/);       // column header
    expect(out).toMatch(/WIN|TRADEOFF|NEUTRAL|LOSS/); // verdict block
  });
});
