import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./main.js";

describe("cli run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 1 on an unknown command", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(["bogus"])).toBe(1);
    err.mockRestore();
  });

  it("creates a corpus, commits, and queries it back", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "c.db");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(["corpus", "create", "c", "--db", db])).toBe(0);
    expect(await run(["commit", "c", "--subject", "host:a", "--key", "status", "--value", "healthy", "--db", db])).toBe(0);
    expect(await run(["query", "c", "where subject = host:a | as text 1000", "--db", db])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("healthy");
    log.mockRestore();
    err.mockRestore();
  });

  it("import command reads a JSONL file and prints throughput stats", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mneme-"));
    const db = join(dir, "i.db");
    const file = join(dir, "data.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ subject: "x:1", key: "color", value: "red" }),
        JSON.stringify({ subject: "x:2", key: "color", value: "blue" }),
      ].join("\n"),
      "utf8",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(["corpus", "create", "c2", "--db", db])).toBe(0);
    const code = await run(["import", "c2", file, "--db", db]);
    expect(code).toBe(0);
    const output = log.mock.calls.flat().join("\n");
    // Should contain the committed count from the import stats line
    expect(output).toMatch(/imported \d+\/2/);
    log.mockRestore();
    err.mockRestore();
  });

  it("--json flag makes query output valid JSON", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "j.db");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(["corpus", "create", "cj", "--db", db])).toBe(0);
    expect(await run(["commit", "cj", "--subject", "node:1", "--key", "type", "--value", "server", "--db", db])).toBe(0);
    expect(await run(["query", "cj", "where subject = node:1 | as text 1000", "--db", db, "--json"])).toBe(0);
    const jsonLine = log.mock.calls.flat().find((s) => {
      try { JSON.parse(String(s)); return true; } catch { return false; }
    });
    expect(jsonLine).toBeDefined();
    log.mockRestore();
    err.mockRestore();
  });

  it("caught domain error prints to stderr and returns 1", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // query a corpus that doesn't exist — should throw and be caught
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "e.db");
    const code = await run(["query", "nonexistent", "where subject = x | as text 10", "--db", db]);
    expect(code).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("corpus ls returns 0", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "ls.db");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(["corpus", "create", "myc", "--db", db])).toBe(0);
    expect(await run(["corpus", "ls", "--db", db])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("myc");
    log.mockRestore();
    err.mockRestore();
  });

  it("corpus inspect returns 0 and prints corpus info", async () => {
    const db = join(mkdtempSync(join(tmpdir(), "mneme-")), "ci.db");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(["corpus", "create", "myc2", "--db", db])).toBe(0);
    expect(await run(["corpus", "inspect", "myc2", "--db", db])).toBe(0);
    expect(log.mock.calls.flat().join("\n")).toContain("myc2");
    log.mockRestore();
    err.mockRestore();
  });
});
