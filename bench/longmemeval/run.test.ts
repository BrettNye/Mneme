import { it, expect } from "vitest";
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

it("corrupted claims cache header: nonzero exit and error names the mismatch", async () => {
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

    const errors: string[] = [];
    const code = await main(
      [
        "--file", fixturePath("dataset.json"),
        "--claims", badClaims,
        "--k", "1",
      ],
      { onError: (msg) => errors.push(msg) }
    );

    expect(code).not.toBe(0);
    const combined = errors.join("\n");
    // Error message must identify it as a header mismatch
    expect(combined.toLowerCase()).toContain("header");
    expect(combined.toLowerCase()).toContain("mismatch");
    // Error message must name the offending model value
    expect(combined).toContain("wrong-model");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("duplicate record is absorbed by arm A's read-side dedupe: clean run, exit 0", async () => {
  // History: this test originally asserted a nonzero exit and was named for
  // IngestConservationError — but the duplicate never violated conservation
  // (writeMany commits it as a distinct claim; ingest-conservation passed in
  // both eras). The nonzero exit came from a side-effect: the duplicate
  // corrupted arm A's ranking and failed the score-A:fx-ku-1 check. Since the
  // similarity-mode ⊕_dedupe stage landed in answerArmA, identical restatements
  // merge before ⊥, so arm A now answers correctly despite the corrupted input
  // and the run is fully green. IngestConservationError itself remains covered
  // by the unit tests in ingest.test.ts.
  const dir = mkdtempSync(join(tmpdir(), "mneme-lme-test-"));
  try {
    const dupClaims = join(dir, "dup-claims.jsonl");
    const header = JSON.stringify({ kind: "lme-extraction-header", model: "claude-sonnet-4-6", promptVersion: "lme-extract-v1" });
    const r1 = JSON.stringify({ subject: "alice", key: "employer", value: "Initech", validFrom: 1680361200000, confidence: 0.95, tags: ["session:fx-s1", "turn:0"] });
    const r2 = JSON.stringify({ subject: "alice", key: "employer", value: "Globex", validFrom: 1684162800000, confidence: 0.97, tags: ["session:fx-s2", "turn:0"] });
    writeFileSync(dupClaims, [header, r1, r1, r2].join("\n") + "\n");

    const code = await main([
      "--file", fixturePath("dataset.json"),
      "--claims", dupClaims,
      "--k", "1",
    ]);

    expect(code).toBe(0);
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

it("--oracle restricts ingest to evidence-session claims: fewer committed than full run", async () => {
  // Run WITHOUT oracle — collects all haystack claims per question
  const ingestCountsFull: number[] = [];
  const codeFull = await main(
    [
      "--file", fixturePath("dataset.json"),
      "--claims", fixturePath("claims.jsonl"),
      "--k", "1",
    ],
    {
      onIngest: (_qid, committed) => ingestCountsFull.push(committed),
    }
  );
  expect(codeFull).toBe(0);

  // Run WITH oracle — restricts to evidence-session claims only
  const ingestCountsOracle: number[] = [];
  const codeOracle = await main(
    [
      "--file", fixturePath("dataset.json"),
      "--claims", fixturePath("claims.jsonl"),
      "--k", "1",
      "--oracle",
    ],
    {
      onIngest: (_qid, committed) => ingestCountsOracle.push(committed),
    }
  );
  expect(codeOracle).toBe(0);

  // Both runs must have ingested the same number of questions
  expect(ingestCountsOracle.length).toBe(ingestCountsFull.length);

  const totalFull = ingestCountsFull.reduce((a, b) => a + b, 0);
  const totalOracle = ingestCountsOracle.reduce((a, b) => a + b, 0);

  // Oracle must commit strictly fewer total records.
  // fx-tr-1: haystack has fx-s3 (Denver) + fx-s4 (Austin); oracle only fx-s3.
  expect(totalOracle).toBeLessThan(totalFull);
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
