import { describe, it, expect } from "vitest";
import { main } from "./drift-injection-sweep.js";

describe("drift-injection-sweep CLI", () => {
  it("errors without --file/--claims", async () => {
    const errs: string[] = [];
    const code = await main([], { onError: (m) => errs.push(m) });
    expect(code).toBe(1);
    expect(errs.join(" ")).toMatch(/--file and --claims are required/);
  });

  it("rejects an out-of-range fraction", async () => {
    const errs: string[] = [];
    const code = await main(
      ["--file", "x.json", "--claims", "y.jsonl", "--fractions", "2.0"],
      { onError: (m) => errs.push(m) },
    );
    expect(code).toBe(1);
    expect(errs.join(" ")).toMatch(/fractions/);
  });

  it("runs the fixture end-to-end and gates the zero-drift baseline", async () => {
    // The fixture KU question scores arm A updateCorrect = 1.0 (run.test.ts:43).
    // The fixture dataset.json is already in LmeQuestion (normalized) form — no --raw.
    const code = await main([
      "--file", "bench/longmemeval/fixtures/dataset.json",
      "--claims", "bench/longmemeval/fixtures/claims.jsonl",
      "--fractions", "0,1.0",
      "--modes", "morph",
      "--expect-update-correct", "1.0",
    ]);
    expect(code).toBe(0);
  });

  it("aborts when the baseline gate value is wrong", async () => {
    const errs: string[] = [];
    const code = await main(
      [
        "--file", "bench/longmemeval/fixtures/dataset.json",
        "--claims", "bench/longmemeval/fixtures/claims.jsonl",
        "--fractions", "0",
        "--modes", "morph",
        "--expect-update-correct", "0.5",
      ],
      { onError: (m) => errs.push(m) },
    );
    expect(code).toBe(1);
    expect(errs.join(" ")).toMatch(/SANITY GATE FAILED/);
  });

  it("fixture run reports resolution columns and zero fragmentation at f=0", async () => {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
    try {
      const code = await main([
        "--file", "bench/longmemeval/fixtures/dataset.json",
        "--claims", "bench/longmemeval/fixtures/claims.jsonl",
        "--fractions", "0,1.0", "--modes", "morph",
        "--expect-update-correct", "1.0",
      ]);
      expect(code).toBe(0);
    } finally { console.log = orig; }
    const out = logs.join("\n");
    expect(out).toMatch(/staleDeprec/);          // new table column header
    expect(out).toMatch(/fragLineages/);          // fragmentation instrument
    expect(out).toMatch(/ranking tax|dropped/i);  // tax line present
    // f=0 has no injected drift → fragLineages (last table column) must be 0 for the f=0 morph off row.
    expect(out).toMatch(/\|\s*0\s*\|\s*morph\s*\|\s*off\s*\|.*\|\s*0\s*\|\s*$/m);
  });
});
