import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecallLog, RecallLogEntry } from "./recall-log.js";

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "mneme-recall-log-"));
  return join(dir, "store.db");
}

const baseEntry: RecallLogEntry = {
  ts: new Date().toISOString(),
  corpus: "test-corpus",
  about: "test query",
  topScore: 0.9,
  matchCount: 3,
  abstained: false,
  rankFn: "cosine",
};

describe("appendRecallLog", () => {
  it("appends one parseable JSONL line beside the db", () => {
    const dbPath = tmpDb();
    appendRecallLog(dbPath, baseEntry);

    const logPath = join(require("node:path").dirname(dbPath), "recall-log.jsonl");
    const content = readFileSync(logPath, "utf-8").trim();
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.corpus).toBe("test-corpus");
    expect(parsed.about).toBe("test query");
    expect(parsed.topScore).toBe(0.9);
    expect(parsed.matchCount).toBe(3);
    expect(parsed.abstained).toBe(false);
    expect(parsed.rankFn).toBe("cosine");
    expect(typeof parsed.ts).toBe("string");
  });

  it("two appends produce two parseable JSONL lines beside the db", () => {
    const dbPath = tmpDb();
    appendRecallLog(dbPath, { ...baseEntry, about: "first query" });
    appendRecallLog(dbPath, { ...baseEntry, about: "second query" });

    const { dirname } = require("node:path");
    const logPath = join(dirname(dbPath), "recall-log.jsonl");
    const content = readFileSync(logPath, "utf-8").trim();
    const lines = content.split("\n").filter(Boolean);
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.about).toBe("first query");
    expect(second.about).toBe("second query");
  });

  it("entry shape matches RecallLogEntry exactly — all fields present", () => {
    const dbPath = tmpDb();
    const entry: RecallLogEntry = {
      ts: "2026-06-05T00:00:00.000Z",
      corpus: "c1",
      about: "about text",
      topScore: 0.75,
      matchCount: 5,
      abstained: true,
      rankFn: "dot-product",
    };
    appendRecallLog(dbPath, entry);

    const { dirname } = require("node:path");
    const logPath = join(dirname(dbPath), "recall-log.jsonl");
    const parsed = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(parsed).toMatchObject({
      ts: "2026-06-05T00:00:00.000Z",
      corpus: "c1",
      about: "about text",
      topScore: 0.75,
      matchCount: 5,
      abstained: true,
      rankFn: "dot-product",
    });
  });

  it("topScore is optional — entry without topScore is still valid", () => {
    const dbPath = tmpDb();
    const entry: RecallLogEntry = {
      ts: new Date().toISOString(),
      corpus: "c2",
      about: "no score",
      matchCount: 0,
      abstained: true,
      rankFn: "cosine",
    };
    appendRecallLog(dbPath, entry);

    const { dirname } = require("node:path");
    const logPath = join(dirname(dbPath), "recall-log.jsonl");
    const parsed = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(parsed.topScore).toBeUndefined();
    expect(parsed.abstained).toBe(true);
  });

  it("serializes coverage missing (count + entities), warning count, and subject/key filter args", () => {
    const dbPath = tmpDb();
    const entry: RecallLogEntry = {
      ts: "2026-06-07T00:00:00.000Z",
      corpus: "knowledge",
      about: "Where did Tom go in Sacramento",
      topScore: 0.42,
      matchCount: 2,
      abstained: false,
      rankFn: "hybrid",
      missingCount: 2,
      missing: ["Tom", "Sacramento"],
      warningCount: 1,
      subject: "project:Mneme",
      key: "preferred_editor",
    };
    appendRecallLog(dbPath, entry);

    const { dirname } = require("node:path");
    const logPath = join(dirname(dbPath), "recall-log.jsonl");
    const parsed = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(parsed.missingCount).toBe(2);
    expect(parsed.missing).toEqual(["Tom", "Sacramento"]);
    expect(parsed.warningCount).toBe(1);
    expect(parsed.subject).toBe("project:Mneme");
    expect(parsed.key).toBe("preferred_editor");
  });

  it("subject/key are optional — an unfiltered recall omits them", () => {
    const dbPath = tmpDb();
    const entry: RecallLogEntry = {
      ts: new Date().toISOString(),
      corpus: "knowledge",
      about: "anything",
      matchCount: 0,
      abstained: false,
      rankFn: "hybrid",
      missingCount: 0,
      missing: [],
      warningCount: 0,
    };
    appendRecallLog(dbPath, entry);

    const { dirname } = require("node:path");
    const logPath = join(dirname(dbPath), "recall-log.jsonl");
    const parsed = JSON.parse(readFileSync(logPath, "utf-8").trim());
    expect(parsed.subject).toBeUndefined();
    expect(parsed.key).toBeUndefined();
    expect(parsed.missingCount).toBe(0);
    expect(parsed.missing).toEqual([]);
    expect(parsed.warningCount).toBe(0);
  });

  it("append failure is swallowed (unwritable path) and logged to stderr", () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        appendRecallLog("Z:/nonexistent/store.db", baseEntry)
      ).not.toThrow();
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
