import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpora, saveCorpora } from "./corpus-store.js";
import type { CorpusDef } from "../index.js";

describe("corpus-store", () => {
  it("returns [] when no sidecar exists", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    expect(loadCorpora(db)).toEqual([]);
  });

  it("round-trips defs after saveCorpora", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "t.db");
    expect(loadCorpora(db)).toEqual([]);
    saveCorpora(db, [{ id: "c", displayName: "C" } as CorpusDef]);
    expect(loadCorpora(db).map((d) => d.id)).toEqual(["c"]);
  });

  it("sidecar path is <dbPath>.corpora.json", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "mydb.db");
    saveCorpora(db, [{ id: "x", displayName: "X" } as CorpusDef]);
    expect(existsSync(`${db}.corpora.json`)).toBe(true);
  });

  it("atomic write: round-trip still works and .tmp file is not left behind", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "atomic.db");
    const defs: CorpusDef[] = [
      { id: "a", displayName: "Alpha" } as CorpusDef,
      { id: "b", displayName: "Beta" } as CorpusDef,
    ];
    saveCorpora(db, defs);
    const loaded = loadCorpora(db);
    expect(loaded.map((d) => d.id)).toEqual(["a", "b"]);
    expect(loaded.map((d) => d.displayName)).toEqual(["Alpha", "Beta"]);
    expect(existsSync(`${db}.corpora.json.tmp`)).toBe(false);
  });

  it("loadCorpora throws a descriptive error when sidecar contains invalid JSON", () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "corrupt.db");
    const sidecarPath = `${db}.corpora.json`;
    writeFileSync(sidecarPath, "this is not valid json {{{{", "utf8");
    expect(() => loadCorpora(db)).toThrow(sidecarPath);
  });

  it("saveCorpora is a no-op for :memory: (writes no sidecar, does not throw)", () => {
    expect(() =>
      saveCorpora(":memory:", [{ id: "m", displayName: "M" } as CorpusDef]),
    ).not.toThrow();
    expect(existsSync(":memory:.corpora.json")).toBe(false);
    expect(loadCorpora(":memory:")).toEqual([]);
  });
});
