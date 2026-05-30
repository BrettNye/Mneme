import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mappers, importFile } from "./import.js";
import type { Session, WriteRecord, ImportStats } from "./types.js";

describe("preset mappers", () => {
  it("maps a conceptnet row, weight -> scalar confidence", () => {
    const r = mappers.conceptnet({ start: "dog", rel: "IsA", end: "animal", weight: 0.8 });
    expect(r).toMatchObject({ subject: "dog", key: "IsA", value: "animal" });
    expect(r!.confidence).toEqual({ distribution: "scalar", parameters: { p: 0.8 }, raw: 0.8 });
  });

  it("maps an icews row, timestamp -> valid.from", () => {
    const r = mappers.icews({ subject: "A", relation: "meets", object: "B", timestamp: 42 });
    expect(r).toMatchObject({ subject: "A", key: "meets", value: "B", valid: { from: 42, to: Infinity } });
  });

  it("clamps weight above 1 to 1 for conceptnet", () => {
    const r = mappers.conceptnet({ start: "x", rel: "IsA", end: "y", weight: 1.5 });
    expect(r!.confidence).toEqual({ distribution: "scalar", parameters: { p: 1 }, raw: 1 });
  });

  it("clamps weight below 0 to 0 for conceptnet", () => {
    const r = mappers.conceptnet({ start: "x", rel: "IsA", end: "y", weight: -0.5 });
    expect(r!.confidence).toEqual({ distribution: "scalar", parameters: { p: 0 }, raw: 0 });
  });

  it("uses weight of 1 when weight is missing for conceptnet", () => {
    const r = mappers.conceptnet({ start: "a", rel: "HasA", end: "b" });
    expect(r!.confidence).toEqual({ distribution: "scalar", parameters: { p: 1 }, raw: 1 });
  });

  it("jsonl passes object through unchanged", () => {
    const rec: WriteRecord = { subject: "s", key: "k", value: "v", source: "manual" };
    const r = mappers.jsonl(rec);
    expect(r).toBe(rec); // same reference, not a copy
  });
});

describe("importFile end-to-end", () => {
  const makeFakeSession = (overrides?: Partial<ImportStats>): Session => {
    const defaultStats: ImportStats = {
      total: 0, committed: 0, rejected: 0, duplicate: 0,
      skipped: 0, elapsedMs: 0, claimsPerSec: 0,
      ...overrides,
    };
    return {
      writeMany: (_corpusId: string, recs: Iterable<WriteRecord>) => {
        let count = 0;
        for (const _r of recs) count++;
        return { ...defaultStats, committed: count };
      },
    } as unknown as Session;
  };

  const writeTempJSONL = (lines: object[]): { dir: string; filePath: string } => {
    const dir = mkdtempSync(join(tmpdir(), "mneme-import-test-"));
    const filePath = join(dir, "fixture.jsonl");
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
    return { dir, filePath };
  };

  it("returns total === N and all stats sum to N for a clean file", async () => {
    const records = [
      { subject: "cat", key: "IsA", value: "animal" },
      { subject: "dog", key: "IsA", value: "animal" },
      { subject: "fish", key: "IsA", value: "animal" },
    ];
    const { dir, filePath } = writeTempJSONL(records);
    try {
      const session = makeFakeSession();
      const stats = await importFile(session, "test-corpus", filePath, { format: "jsonl" });
      expect(stats.total).toBe(3);
      const summed = stats.committed + stats.rejected + stats.duplicate + stats.skipped;
      expect(summed).toBe(3);
      expect(stats.claimsPerSec).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("skips malformed JSON lines and counts them as skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mneme-import-malformed-"));
    const filePath = join(dir, "fixture.jsonl");
    writeFileSync(
      filePath,
      [
        JSON.stringify({ subject: "cat", key: "IsA", value: "animal" }),
        "NOT VALID JSON {{{",
        JSON.stringify({ subject: "dog", key: "IsA", value: "animal" }),
      ].join("\n"),
      "utf8",
    );
    try {
      const session = makeFakeSession();
      const stats = await importFile(session, "test-corpus", filePath, { format: "jsonl" });
      expect(stats.total).toBe(3);
      expect(stats.skipped).toBe(1);
      expect(stats.committed).toBe(2);
      const summed = stats.committed + stats.rejected + stats.duplicate + stats.skipped;
      expect(summed).toBe(3);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("records flow through session.writeMany", async () => {
    const records = [
      { subject: "A", key: "rel", value: "B" },
      { subject: "C", key: "rel", value: "D" },
    ];
    const { dir, filePath } = writeTempJSONL(records);
    const writeManyMock = vi.fn((_corpusId: string, recs: Iterable<WriteRecord>): ImportStats => {
      let count = 0;
      for (const _r of recs) count++;
      return { total: count, committed: count, rejected: 0, duplicate: 0, skipped: 0, elapsedMs: 0, claimsPerSec: 0 };
    });
    const fakeSession = { writeMany: writeManyMock } as unknown as Session;
    try {
      const stats = await importFile(fakeSession, "my-corpus", filePath, { format: "jsonl" });
      expect(writeManyMock).toHaveBeenCalledOnce();
      expect(writeManyMock).toHaveBeenCalledWith("my-corpus", expect.any(Array));
      expect(stats.committed).toBe(2);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("batches correctly when records exceed batchSize", async () => {
    const records = Array.from({ length: 5 }, (_, i) => ({
      subject: `s${i}`, key: "k", value: "v",
    }));
    const { dir, filePath } = writeTempJSONL(records);
    const writeManyMock = vi.fn((_corpusId: string, recs: Iterable<WriteRecord>): ImportStats => {
      let count = 0;
      for (const _r of recs) count++;
      return { total: count, committed: count, rejected: 0, duplicate: 0, skipped: 0, elapsedMs: 0, claimsPerSec: 0 };
    });
    const fakeSession = { writeMany: writeManyMock } as unknown as Session;
    try {
      const stats = await importFile(fakeSession, "corp", filePath, { format: "jsonl", batchSize: 2 });
      // 5 records with batchSize 2: flushes at 2, 4, and remainder 1 => 3 calls
      expect(writeManyMock).toHaveBeenCalledTimes(3);
      expect(stats.committed).toBe(5);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("skips blank lines without counting them as total", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mneme-import-blank-"));
    const filePath = join(dir, "fixture.jsonl");
    writeFileSync(
      filePath,
      [
        JSON.stringify({ subject: "x", key: "k", value: "v" }),
        "",
        "  ",
        JSON.stringify({ subject: "y", key: "k", value: "v" }),
      ].join("\n"),
      "utf8",
    );
    try {
      const session = makeFakeSession();
      const stats = await importFile(session, "corp", filePath, { format: "jsonl" });
      expect(stats.total).toBe(2); // blank lines not counted
      expect(stats.committed).toBe(2);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("calls onProgress callback during processing", async () => {
    const records = [
      { subject: "a", key: "k", value: "v" },
      { subject: "b", key: "k", value: "v" },
    ];
    const { dir, filePath } = writeTempJSONL(records);
    const progressCalls: number[] = [];
    try {
      const session = makeFakeSession();
      await importFile(session, "corp", filePath, {
        format: "jsonl",
        batchSize: 1,
        onProgress: (n) => progressCalls.push(n),
      });
      // batchSize 1 means flush after every record, onProgress called after each flush
      expect(progressCalls.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
