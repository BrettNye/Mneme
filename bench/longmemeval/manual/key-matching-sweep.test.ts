import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { main, type SweepCell } from "./key-matching-sweep.js";

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe("key-matching sweep smoke (fixtures, zero-model)", () => {
  it("runs end-to-end; theta above all scores reproduces the baseline exactly", async () => {
    let cells: SweepCell[] = [];
    const code = await main(
      ["--file", fixture("dataset.json"), "--claims", fixture("claims.jsonl"), "--thetas", "0.99"],
      { collect: (c) => (cells = c) },
    );
    expect(code).toBe(0);

    const baseline = cells.find((c) => c.theta === "baseline");
    const high = cells.find((c) => c.scorer === "jaccard" && c.theta === 0.99);
    expect(baseline).toBeDefined();
    expect(high).toBeDefined();
    // theta=0.99 merges nothing on the fixture keys → identity with baseline
    expect(high!.aliases).toBe(0);
    expect(high!.rows).toEqual(baseline!.rows);
  }, 120_000);

  it("sanity gate aborts on a wrong expected baseline", async () => {
    const errors: string[] = [];
    const code = await main(
      [
        "--file", fixture("dataset.json"),
        "--claims", fixture("claims.jsonl"),
        "--thetas", "0.99",
        "--expect-update-correct", "0.123",
      ],
      { onError: (m) => errors.push(m) },
    );
    expect(code).toBe(1);
    expect(errors.some((m) => m.includes("SANITY GATE FAILED"))).toBe(true);
  }, 120_000);
});
