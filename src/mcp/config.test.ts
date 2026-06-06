import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMnemeConfig } from "./config.js";

function makeTmpDb(): { dir: string; db: string; cfg: string } {
  const dir = mkdtempSync(join(tmpdir(), "mneme-cfg-"));
  const db = join(dir, "store.db");
  const cfg = join(dir, "config.json");
  return { dir, db, cfg };
}

describe("loadMnemeConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty object when config.json is absent", () => {
    const { db } = makeTmpDb();
    expect(loadMnemeConfig(db)).toEqual({});
  });

  it("parses a valid config with keyCardinality", () => {
    const { db, cfg } = makeTmpDb();
    writeFileSync(cfg, JSON.stringify({ keyCardinality: { decision: "single", tags: "multi" } }));
    const result = loadMnemeConfig(db);
    expect(result.keyCardinality).toEqual({ decision: "single", tags: "multi" });
  });

  it("parses a valid config with no keyCardinality (empty object)", () => {
    const { db, cfg } = makeTmpDb();
    writeFileSync(cfg, JSON.stringify({}));
    expect(loadMnemeConfig(db)).toEqual({});
  });

  it("throws on malformed JSON naming the path", () => {
    const { db, cfg } = makeTmpDb();
    writeFileSync(cfg, "{ not valid json }");
    expect(() => loadMnemeConfig(db)).toThrow(cfg);
  });

  it("rejects invalid cardinality values loudly, naming key and value", () => {
    const { db, cfg } = makeTmpDb();
    writeFileSync(cfg, JSON.stringify({ keyCardinality: { decision: "many" } }));
    expect(() => loadMnemeConfig(db)).toThrow(/keyCardinality/);
    // Also check key+value are mentioned
    try {
      loadMnemeConfig(db);
    } catch (e: unknown) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/decision/);
      expect(msg).toMatch(/many/);
    }
  });

  it("re-throws non-ENOENT read errors instead of returning {}", () => {
    const { db, cfg } = makeTmpDb();
    // config.json as a directory => EISDIR on read, must not be masked as "absent"
    mkdirSync(cfg);
    expect(() => loadMnemeConfig(db)).toThrow();
  });

  it("throws when keyCardinality is a non-object string", () => {
    const { db, cfg } = makeTmpDb();
    writeFileSync(cfg, JSON.stringify({ keyCardinality: "single" }));
    expect(() => loadMnemeConfig(db)).toThrow(/keyCardinality must be a plain object/);
  });

  it("throws when keyCardinality is an array", () => {
    const { db, cfg } = makeTmpDb();
    writeFileSync(cfg, JSON.stringify({ keyCardinality: [1, 2] }));
    expect(() => loadMnemeConfig(db)).toThrow(/keyCardinality must be a plain object/);
  });

  it("throws when a keyCardinality map value is a non-string", () => {
    const { db, cfg } = makeTmpDb();
    writeFileSync(cfg, JSON.stringify({ keyCardinality: { decision: 42 } }));
    expect(() => loadMnemeConfig(db)).toThrow(/keyCardinality\["decision"\]/);
  });

  it("warns and drops unknown top-level keys", () => {
    const { db, cfg } = makeTmpDb();
    writeFileSync(cfg, JSON.stringify({ keyCardinality: { x: "single" }, unknownKey: 42 }));
    const warnSpy = vi.spyOn(console, "warn");
    const result = loadMnemeConfig(db);
    expect(result).not.toHaveProperty("unknownKey");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/unknownKey/));
  });

  it("derives config path as sibling of dbPath (dirname/config.json)", () => {
    const { db, cfg } = makeTmpDb();
    writeFileSync(cfg, JSON.stringify({ keyCardinality: { status: "single" } }));
    // Using a db path that is NOT at dir root, but still sibling derivation should work
    const result = loadMnemeConfig(db);
    expect(result.keyCardinality).toEqual({ status: "single" });
  });
});
