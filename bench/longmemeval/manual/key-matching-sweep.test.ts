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

it("--ratified with no matching approved pairs is a baseline identity and adds a ratified row", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "ratify-test-"));
  const judgments = join(dir, "judgments.jsonl");
  writeFileSync(
    judgments,
    JSON.stringify({ kind: "key-ratify-header", model: "x", promptVersion: "ratify-v1", suggestTheta: 0.92 }) + "\n" +
      JSON.stringify({ a: "no such key", b: "also absent", same: true, reason: "test", score: 0.95 }) + "\n" +
      JSON.stringify({ a: "rejected a", b: "rejected b", same: false, reason: "test", score: 0.93 }) + "\n",
    "utf8",
  );
  let cells: SweepCell[] = [];
  const code = await main(
    ["--file", fixture("dataset.json"), "--claims", fixture("claims.jsonl"), "--thetas", "0.99", "--ratified", judgments],
    { collect: (c) => (cells = c) },
  );
  expect(code).toBe(0);
  const ratified = cells.find((c) => c.scorer === "ratified");
  const baseline = cells.find((c) => c.theta === "baseline");
  expect(ratified).toBeDefined();
  expect(ratified!.aliases).toBe(0); // approved pair never co-occurs in fixture corpora
  expect(ratified!.rows).toEqual(baseline!.rows); // identity
}, 120_000);

it("--agent-decides adds an agent cell (fixtures fully covered -> identity with ratified)", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "agent-test-"));
  const judgments = join(dir, "judgments.jsonl");
  writeFileSync(
    judgments,
    JSON.stringify({ kind: "key-ratify-header", model: "x", promptVersion: "ratify-v1", suggestTheta: 0.92 }) + "\n" +
      JSON.stringify({ a: "no such key", b: "also absent", same: true, reason: "test", score: 0.95 }) + "\n",
    "utf8",
  );
  let cells: SweepCell[] = [];
  const code = await main(
    ["--file", fixture("dataset.json"), "--claims", fixture("claims.jsonl"), "--thetas", "0.99", "--ratified", judgments, "--agent-decides"],
    { collect: (c) => (cells = c) },
  );
  expect(code).toBe(0);
  const agent = cells.find((c) => c.scorer === "agent");
  expect(agent).toBeDefined();
  expect(agent!.rows.length).toBeGreaterThan(0);
}, 120_000);

it("--distractors runs end-to-end on fixtures (corpora enlarged, no conservation errors)", async () => {
  let cells: SweepCell[] = [];
  const code = await main(
    ["--file", fixture("dataset.json"), "--claims", fixture("claims.jsonl"), "--thetas", "0.99", "--distractors", "2"],
    { collect: (c) => (cells = c) },
  );
  expect(code).toBe(0);
  expect(cells.find((c) => c.theta === "baseline")).toBeDefined();
});

it("--distractors with --expect-update-correct is rejected (gate is oracle-calibrated)", async () => {
  const errors: string[] = [];
  const code = await main(
    ["--file", fixture("dataset.json"), "--claims", fixture("claims.jsonl"), "--thetas", "0.99", "--distractors", "2", "--expect-update-correct", "0.403"],
    { onError: (m) => errors.push(m) },
  );
  expect(code).toBe(1);
  expect(errors.some((m) => m.includes("oracle-calibrated"))).toBe(true);
});
