import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./run.js";
import { fixturePath } from "./test-support.js";
import type { ScoreRow } from "./score.js";

it("fixture e2e: exits 0 and scores 3 categories × 2 arms", async () => {
  const rows: ScoreRow[] = [];
  let tmpDir: string | undefined;

  const code = await main(
    [
      "--file", fixturePath("dataset.json"),
      "--claims", fixturePath("claims.jsonl"),
      "--k", "1,3",
    ],
    {
      collect: (r) => rows.push(...r),
      onTmpDir: (d) => { tmpDir = d; },
    }
  );

  expect(code).toBe(0); // conservation + scoring checks all pass, table printed

  // Should have rows for 3 categories × 2 arms × relevant metrics
  const categories = new Set(rows.map((r) => r.category));
  expect(categories.has("knowledge-update")).toBe(true);
  expect(categories.has("temporal-reasoning")).toBe(true);
  expect(categories.has("abstention")).toBe(true);

  const arms = new Set(rows.map((r) => r.arm));
  expect(arms.has("A")).toBe(true);
  expect(arms.has("B")).toBe(true);

  // Verify that the tmp dir was cleaned up
  if (tmpDir !== undefined) {
    expect(existsSync(tmpDir)).toBe(false);
  }
});

it("KU fixture: arm A updateCorrect=1.0, arm B updateCorrect=0.0", async () => {
  const rows: ScoreRow[] = [];

  const code = await main(
    [
      "--file", fixturePath("dataset.json"),
      "--claims", fixturePath("claims.jsonl"),
      "--k", "1",
    ],
    { collect: (r) => rows.push(...r) }
  );

  expect(code).toBe(0);

  const kuArmA = rows.find(
    (r) => r.category === "knowledge-update" && r.arm === "A" && r.metric === "updateCorrect"
  );
  const kuArmB = rows.find(
    (r) => r.category === "knowledge-update" && r.arm === "B" && r.metric === "updateCorrect"
  );

  expect(kuArmA).toBeDefined();
  expect(kuArmA!.value).toBe(1.0);

  expect(kuArmB).toBeDefined();
  expect(kuArmB!.value).toBe(0.0);
});

it("corrupted claims cache header: nonzero exit before ingest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-lme-test-"));
  try {
    const badClaims = join(dir, "bad-claims.jsonl");
    writeFileSync(
      badClaims,
      [
        JSON.stringify({ kind: "lme-extraction-header", model: "wrong-model", promptVersion: "lme-extract-v1" }),
        JSON.stringify({ subject: "alice", key: "employer", value: "Initech", validFrom: 1680361200000, confidence: 0.95, tags: ["session:fx-s1", "turn:0"] }),
      ].join("\n") + "\n"
    );

    const code = await main([
      "--file", fixturePath("dataset.json"),
      "--claims", badClaims,
      "--k", "1",
    ]);

    expect(code).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("duplicate record causes conservation failure: nonzero exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-lme-test-"));
  try {
    const dupClaims = join(dir, "dup-claims.jsonl");
    // Use a duplicate record for fx-ku-1 to trigger IngestConservationError
    const header = JSON.stringify({ kind: "lme-extraction-header", model: "claude-sonnet-4-6", promptVersion: "lme-extract-v1" });
    const r1 = JSON.stringify({ subject: "alice", key: "employer", value: "Initech", validFrom: 1680361200000, confidence: 0.95, tags: ["session:fx-s1", "turn:0"] });
    const r2 = JSON.stringify({ subject: "alice", key: "employer", value: "Globex", validFrom: 1684162800000, confidence: 0.97, tags: ["session:fx-s2", "turn:0"] });
    // Duplicate r1 to cause conservation error (same claim written twice = duplicate)
    writeFileSync(dupClaims, [header, r1, r1, r2].join("\n") + "\n");

    const code = await main([
      "--file", fixturePath("dataset.json"),
      "--claims", dupClaims,
      "--k", "1",
    ]);

    expect(code).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("tmp dir is removed after run", async () => {
  let tmpDir: string | undefined;

  await main(
    [
      "--file", fixturePath("dataset.json"),
      "--claims", fixturePath("claims.jsonl"),
      "--k", "1",
    ],
    { onTmpDir: (d) => { tmpDir = d; } }
  );

  expect(tmpDir).toBeDefined();
  expect(existsSync(tmpDir!)).toBe(false);
});

it("--oracle restricts ingest to evidence-session claims", async () => {
  const rows: ScoreRow[] = [];

  const code = await main(
    [
      "--file", fixturePath("dataset.json"),
      "--claims", fixturePath("claims.jsonl"),
      "--k", "1",
      "--oracle",
    ],
    { collect: (r) => rows.push(...r) }
  );

  // With oracle, the run still succeeds (oracle picks fewer records — not duplicates)
  expect(code).toBe(0);

  // Arm A / B for KU still produces rows
  const kuRows = rows.filter((r) => r.category === "knowledge-update");
  expect(kuRows.length).toBeGreaterThan(0);
});

it("missing dataset file: nonzero exit with clear message", async () => {
  const code = await main([
    "--file", "/nonexistent/dataset.json",
    "--claims", fixturePath("claims.jsonl"),
  ]);
  expect(code).not.toBe(0);
});

it("missing claims file: nonzero exit with clear message", async () => {
  const code = await main([
    "--file", fixturePath("dataset.json"),
    "--claims", "/nonexistent/claims.jsonl",
  ]);
  expect(code).not.toBe(0);
});
